/**
 * BingX Demo Trading Bot — MA20 Scalper v3.1 (Hedge Fund Edition)
 * Target: $200/day | $50,000/year
 *
 * Strategy:
 *   • LONG : GREEN candle + prev RED  + close ≥ MA20 + within 0.5% + MA20>SMA200 + RSI<70
 *   • SHORT: RED candle  + prev GREEN + close ≤ MA20 + within 0.5% + MA20<SMA200 + RSI>30
 *   • Entry valid on 1st or 2nd candle close only (2-candle freshness window)
 *
 * Risk management:
 *   • Stop-loss     -3%  PnL on margin  (hard, checked every 5s)
 *   • Take-profit   +6%  PnL on margin  (2:1 R:R, locks gain)
 *   • Trailing stop activates at +3%, trails 2% below peak
 *   • $200/day target — tracked & displayed, NEVER halts trading
 *   • Win-rate circuit breaker: pause 30 min if WR < 40% (min 10 trades)
 *   • Signal quality scoring → position size 50% / 75% / 100%
 *   • Bot trades 24/7 — no daily loss limit, no entry cap
 *
 * Bug fixes in v3.1:
 *   1. calcQty precision: dynamic decimal places by price tier (BTC no longer skipped)
 *   2. Double-exit guard: closingPositions Set prevents re-closing in-flight exits
 *   3. livePrice fetched when method A used → accurate stop/TP/trail log prices
 *   4. checkDailyReset() called in pollExits → peakPnl cleared at midnight
 *   5. peakPnl + winRatePauseUntil declared before checkDailyReset (no TDZ risk)
 *   6. Removed dead DAILY_LOSS_LIM variable
 *   7. MAX_DAILY hit now logs a message
 *   8. closingPositions cleared on confirmed close
 */

import axios from "axios";
import crypto from "crypto";
import { readFileSync, existsSync } from "fs";
import http from "http";

// ── Load rules.json ────────────────────────────────────────────────────────────
function loadRules() {
  for (const p of ["./rules.json", "C:/Users/ALEXIS/bingx-mcp/rules.json"]) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch {}
  }
  throw new Error("rules.json not found");
}
const RULES = loadRules();

// ── Config ─────────────────────────────────────────────────────────────────────
const BASE_URL        = "https://open-api-vst.bingx.com";
const TIMEFRAME       = RULES.timeframe;
const MA_PERIOD       = RULES.indicators.MA20.length;              // 20
const SMA_PERIOD      = RULES.indicators.SMA200.length;            // 200
const RSI_PERIOD      = 14;
const LEVERAGE        = RULES.position_sizing.leverage;            // 5
const RISK_PCT        = RULES.position_sizing.risk_pct;            // 0.01
const MAX_MARGIN      = RULES.position_sizing.max_margin;          // 500
const MIN_NOTIONAL    = RULES.position_sizing.min_notional;        // 5
const MAX_OPEN        = RULES.limits.max_open_positions;           // 20
const MAX_DAILY       = RULES.limits.max_trades_per_day;           // 500
const ORDER_DELAY_MS  = RULES.limits.api_delay_ms       || 500;
const FETCH_DELAY_MS  = RULES.limits.fetch_delay_ms     || 200;
const SCAN_MS         = RULES.limits.scan_interval_ms   || 5000;
const EXIT_POLL_MS    = RULES.limits.exit_poll_ms        || 5000;
const MIN_BODY_PCT    = 0.0002;
const MAX_MA_DIST_PCT = RULES.entry?.max_ma_distance_pct || 0.005;

// ── Risk Management Config ─────────────────────────────────────────────────────
const rm              = RULES.risk_management || {};
const STOP_LOSS_PCT   = rm.stop_loss_pct           || RULES.limits.stop_loss_pct || 0.03;
const TAKE_PROFIT_PCT = rm.take_profit_pct         || 0.06;   // +6% PnL on margin
const TRAIL_ON_PCT    = rm.trail_activate_pct      || 0.03;   // start trailing at +3%
const TRAIL_DIST_PCT  = rm.trail_distance_pct      || 0.02;   // trail 2% below peak
const DAILY_TARGET    = rm.daily_profit_target_usdt || 200;
const WR_MIN          = rm.win_rate_min             || 0.40;   // 40% min win rate
const WR_MIN_TRADES   = rm.win_rate_min_trades      || 10;     // trigger after 10+ trades
const WR_PAUSE_MS     = (rm.win_rate_pause_minutes  || 30) * 60_000;

const BLACKLIST = new Set(RULES.blacklist || []);
const WATCHLIST = (RULES.watchlist || []).filter(s => !BLACKLIST.has(s));
const PORT      = process.env.PORT || 3000;

const CANDLE_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000,
  "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000
}[TIMEFRAME] ?? 60_000;

// ── Credentials ────────────────────────────────────────────────────────────────
function creds() {
  const k = process.env.BINGX_API_KEY    || "";
  const s = process.env.BINGX_SECRET_KEY || process.env.BINGX_API_SECRET || "";
  if (k && s) return { k, s };
  try {
    const raw  = readFileSync("C:/Users/ALEXIS/bingx-mcp/.env", "utf8");
    const vars = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.+?)\s*$/);
      if (m) vars[m[1]] = m[2];
    }
    return { k: vars.BINGX_API_KEY || "", s: vars.BINGX_SECRET_KEY || vars.BINGX_API_SECRET || "" };
  } catch { return { k: "", s: "" }; }
}

// ── Clock sync ─────────────────────────────────────────────────────────────────
let clockOffset = 0;
async function syncClock() {
  try {
    const r = await axios.get(`${BASE_URL}/openApi/swap/v2/server/time`, { timeout: 5000 });
    clockOffset = (r.data?.data?.serverTime || Date.now()) - Date.now();
    log(`⏱  Clock synced: offset=${clockOffset}ms`);
  } catch (e) { log(`WARN: clock sync failed — ${e.message}`); }
}
const bingxNow = () => Date.now() + clockOffset;
setInterval(syncClock, 60 * 60 * 1000);  // re-sync hourly

// ── API helpers ────────────────────────────────────────────────────────────────
function buildQS(params, secret) {
  const keys = Object.keys(params).sort();
  const str  = keys.map(k => `${k}=${params[k]}`).join("&");
  const sig  = crypto.createHmac("sha256", secret).update(str).digest("hex");
  return keys.map(k => `${k}=${encodeURIComponent(params[k])}`).join("&") + `&signature=${sig}`;
}
async function GET(path, params = {}) {
  const { k, s } = creds();
  const qs = buildQS({ ...params, timestamp: bingxNow() }, s);
  const r  = await axios.get(`${BASE_URL}${path}?${qs}`, { headers: { "X-BX-APIKEY": k }, timeout: 5000 });
  return r.data;
}
async function POST(path, params = {}) {
  const { k, s } = creds();
  const qs = buildQS({ ...params, timestamp: bingxNow() }, s);
  const r  = await axios.post(`${BASE_URL}${path}?${qs}`, null, { headers: { "X-BX-APIKEY": k }, timeout: 5000 });
  return r.data;
}

// ── Stats & logging ────────────────────────────────────────────────────────────
const perf  = { wins: 0, losses: 0, dailyPnl: 0 };
const stats = { start: new Date().toISOString(), lastScan: null, lastExit: null, trades: 0, errors: 0, log: [] };

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  stats.log.push(line);
  if (stats.log.length > 1000) stats.log.shift();
}

// ── FIX #5/6: Declare shared state BEFORE the functions that use them ──────────
const peakPnl          = new Map();   // `${symbol}-${side}` → highest pnlPct seen (trailing stop)
const closingPositions = new Set();   // FIX #2: positions with in-flight close orders
let   winRatePauseUntil = 0;

// ── Daily reset ────────────────────────────────────────────────────────────────
let tradeToday = 0;
let tradeDate  = new Date().toISOString().slice(0, 10);

function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== tradeDate) {
    tradeDate          = today;
    tradeToday         = 0;
    perf.dailyPnl      = 0;
    perf.wins          = 0;
    perf.losses        = 0;
    winRatePauseUntil  = 0;
    peakPnl.clear();
    closingPositions.clear();
    log(`📅 Daily reset — all counters cleared`);
  }
}

// ── Circuit breaker ────────────────────────────────────────────────────────────
function checkCircuitBreaker() {
  const total = perf.wins + perf.losses;
  if (total < WR_MIN_TRADES) return false;

  const wr = perf.wins / total;
  if (wr >= WR_MIN) return false;

  if (Date.now() < winRatePauseUntil) return true;

  winRatePauseUntil = Date.now() + WR_PAUSE_MS;
  log(`⚠️  CIRCUIT BREAKER — Win rate ${(wr * 100).toFixed(1)}% < ${WR_MIN * 100}% after ${total} trades → pausing ${WR_PAUSE_MS / 60000}min`);
  return true;
}

// ── Indicators ─────────────────────────────────────────────────────────────────
function sma(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function rsi(closes, period = RSI_PERIOD) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i] - recent[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  const avgG = gains  / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - (100 / (1 + avgG / avgL));
}

// ── Signal quality score (3–8) → position size multiplier ─────────────────────
function signalScore(distPct, bodyPct, ma20, sma200) {
  let s = 0;
  // Proximity to MA20 (1-3 pts)
  if (distPct < 0.001)      s += 3;
  else if (distPct < 0.003) s += 2;
  else                      s += 1;
  // Candle body strength (1-3 pts)
  if (bodyPct > 0.002)      s += 3;
  else if (bodyPct > 0.001) s += 2;
  else                      s += 1;
  // Trend gap MA20 vs SMA200 (1-2 pts)
  const trendGap = sma200 > 0 ? Math.abs(ma20 - sma200) / sma200 : 0;
  if (trendGap > 0.005)     s += 2;
  else                      s += 1;
  return s;   // range: 3–8
}

function sizeMultiplier(score) {
  if (score >= 7) return 1.00;   // A+ signal → full size
  if (score >= 5) return 0.75;   // B  signal → 75%
  return 0.50;                   // C  signal → 50%
}

// ── Entry signal ───────────────────────────────────────────────────────────────
//  LONG:  GREEN candle + prev RED  + close ≥ MA20 (≤0.5% away) + MA20>SMA200 + RSI<70
//  SHORT: RED candle  + prev GREEN + close ≤ MA20 (≤0.5% away) + MA20<SMA200 + RSI>30
//  Returns { signal, score, distPct, bodyPct, rsi, ma20, sma200 } or null
function checkEntry(candles) {
  if (candles.length < SMA_PERIOD + 3) return null;

  const curr = candles[candles.length - 2];   // last CLOSED bar
  const prev = candles[candles.length - 3];   // bar before last closed

  // Time unit safety (BingX returns ms; guard against seconds)
  const candleTime = curr.time < 1_000_000_000_000 ? curr.time * 1000 : curr.time;

  // Freshness: max 2 candle closes after signal candle close
  const signalAge = bingxNow() - (candleTime + CANDLE_MS);
  if (signalAge < 0)              return null;  // candle close still in the future
  if (signalAge >= CANDLE_MS * 2) return null;  // 3rd+ candle has closed → stale

  // Indicators — closed bars only (forming bar excluded via slice(0,-1))
  const cc     = candles.slice(0, -1).map(c => c.close);
  const ma20   = sma(cc, MA_PERIOD);
  const sma200 = sma(cc, SMA_PERIOD);
  const rsiVal = rsi(cc);
  if (!ma20 || !sma200) return null;

  // Trend bias filter (MA20 vs SMA200)
  const bullish = ma20 > sma200;
  const bearish = ma20 < sma200;
  if (!bullish && !bearish) return null;  // MA20 == SMA200 → neutral, skip

  // Minimum candle body (0.02% to filter doji/noise)
  const bodyPct = Math.abs(curr.close - curr.open) / curr.open;
  if (bodyPct < MIN_BODY_PCT) return null;

  // MA20 proximity — entry must be within 0.5% of MA20 (no chasing)
  const distPct = Math.abs(curr.close - ma20) / ma20;
  if (distPct > MAX_MA_DIST_PCT) return null;

  const currGreen = curr.close > curr.open;
  const currRed   = curr.close < curr.open;
  const prevRed   = prev.close < prev.open;
  const prevGreen = prev.close > prev.open;

  // RSI filter — skip overbought LONGs and oversold SHORTs
  const rsiOK_long  = !rsiVal || rsiVal < 70;
  const rsiOK_short = !rsiVal || rsiVal > 30;

  let signal = null;
  if (bullish && currGreen && prevRed   && curr.close >= ma20 && rsiOK_long)  signal = "LONG";
  if (bearish && currRed   && prevGreen && curr.close <= ma20 && rsiOK_short) signal = "SHORT";
  if (!signal) return null;

  const score = signalScore(distPct, bodyPct, ma20, sma200);
  return { signal, score, distPct, bodyPct, rsi: rsiVal, ma20, sma200 };
}

// ── Exit signal (MA20 crossover only — no freshness guard, exits must always fire) ──
function checkExit(candles, side) {
  if (candles.length < SMA_PERIOD + 3) return false;

  const cc     = candles.slice(0, -1).map(c => c.close);
  const ccPrev = cc.slice(0, -1);

  const currClose = cc[cc.length - 1];
  const prevClose = ccPrev[ccPrev.length - 1];
  const currMA    = sma(cc,     MA_PERIOD);
  const prevMA    = sma(ccPrev, MA_PERIOD);
  if (!currMA || !prevMA) return false;

  if (side === "LONG")  return currClose < currMA && prevClose >= prevMA;
  if (side === "SHORT") return currClose > currMA && prevClose <= prevMA;
  return false;
}

// ── Market data ────────────────────────────────────────────────────────────────
async function getCandles(symbol) {
  try {
    const d = await GET("/openApi/swap/v3/quote/klines", {
      symbol, interval: TIMEFRAME, limit: SMA_PERIOD + 4
    });
    if (!Array.isArray(d?.data)) return [];
    const candles = d.data.map(c => {
      let t = Number(c.time);
      if (t > 0 && t < 1_000_000_000_000) t *= 1000;
      return { time: t, open: parseFloat(c.open), close: parseFloat(c.close) };
    });
    candles.sort((a, b) => a.time - b.time);
    return candles;
  } catch { return []; }
}

async function getBalance() {
  try {
    const d = await GET("/openApi/swap/v2/user/balance");
    return parseFloat(d?.data?.balance?.availableMargin || 0);
  } catch { return 0; }
}

async function getOpenPositions() {
  try {
    const d = await GET("/openApi/swap/v2/user/positions");
    return (d?.data || []).filter(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
  } catch { return []; }
}

async function getLivePrice(symbol) {
  try {
    const d = await GET("/openApi/swap/v2/quote/price", { symbol });
    return parseFloat(d?.data?.price || 0);
  } catch { return 0; }
}

// ── FIX #1: Position sizing — dynamic decimal precision by price tier ──────────
//  OLD: Math.floor(x * 10) / 10  →  1 decimal  →  BTC@$100k gives qty=0 (SKIPPED)
//  NEW: precision scales with price so every symbol gets a valid, tradable qty
function calcQty(bal, price, multiplier = 1.0) {
  if (!bal || !price) return 0;
  const margin   = Math.min(bal * RISK_PCT, MAX_MARGIN) * multiplier;
  const notional = margin * LEVERAGE;
  const rawQty   = notional / price;

  //  Price tier  →  decimals   Example
  //  ≥ $10,000   →  4          BTC $100k: qty=0.0050 ✓  (was 0 ✗)
  //  ≥ $1,000    →  3          ETH  $2.5k: qty=0.200 ✓
  //  ≥ $10       →  2          SOL   $150: qty=3.33  ✓
  //  ≥ $1        →  1          NEAR    $5: qty=50.0  ✓
  //  < $1        →  0          DOGE $0.20: qty=2500  ✓
  let decimals;
  if      (price >= 10_000) decimals = 4;
  else if (price >=  1_000) decimals = 3;
  else if (price >=     10) decimals = 2;
  else if (price >=      1) decimals = 1;
  else                      decimals = 0;

  const factor = 10 ** decimals;
  return Math.floor(rawQty * factor) / factor;
}

// ── Place entry ────────────────────────────────────────────────────────────────
async function placeEntry(symbol, signal, score, bal) {
  try {
    const price = await getLivePrice(symbol);
    if (!price) { log(`SKIP ${symbol} — no live price`); return false; }

    const mult     = sizeMultiplier(score);
    const qty      = calcQty(bal, price, mult);
    const notional = qty * price;
    if (qty <= 0 || notional < MIN_NOTIONAL) {
      log(`SKIP ${symbol} qty=${qty} notional=${notional.toFixed(2)} < min`);
      return false;
    }

    const side         = signal === "LONG" ? "BUY" : "SELL";
    const positionSide = signal;

    // Set leverage (ignore failure — may already be set)
    try { await POST("/openApi/swap/v2/trade/leverage", { symbol, side: signal, leverage: LEVERAGE }); } catch {}

    const r = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: qty
    });

    if (r?.code === 0) {
      stats.trades++;
      tradeToday++;
      log(`✅ ENTRY ${signal.padEnd(5)} ${symbol.padEnd(18)} qty=${qty} @~${price} ${LEVERAGE}x | score=${score}/8(${(mult*100).toFixed(0)}%) | today=${tradeToday}`);
      return true;
    } else {
      log(`❌ ENTRY FAIL  ${symbol} code=${r?.code} msg=${r?.msg}`);
      return false;
    }
  } catch (e) {
    stats.errors++;
    log(`❌ ENTRY ERROR ${symbol}: ${e.message}`);
    return false;
  }
}

// ── Place exit ─────────────────────────────────────────────────────────────────
async function placeExit(symbol, positionSide, qty, entryPrice, reason, knownPrice = 0) {
  try {
    // FIX #3: always resolve a real exit price for accurate PnL logging
    const exitPrice = knownPrice || await getLivePrice(symbol);
    if (!exitPrice) { log(`SKIP EXIT ${symbol} — no live price`); return false; }

    const side = positionSide === "LONG" ? "SELL" : "BUY";
    const r    = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: Math.abs(qty)
    });

    if (r?.code === 0) {
      const margin   = Math.min(Math.abs(qty) * entryPrice / LEVERAGE, MAX_MARGIN);
      const pricePct = positionSide === "LONG"
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;
      const pnl    = pricePct * margin * LEVERAGE;
      const pnlPct = pricePct * LEVERAGE * 100;

      perf.dailyPnl += pnl;
      if (pnl >= 0) perf.wins++; else perf.losses++;

      const total = perf.wins + perf.losses;
      const wr    = total ? ((perf.wins / total) * 100).toFixed(1) : "0.0";
      const icon  = pnl >= 0 ? "✅" : "❌";

      // FIX #2: remove from in-flight set on confirmed close
      peakPnl.delete(`${symbol}-${positionSide}`);
      closingPositions.delete(`${symbol}-${positionSide}`);

      stats.lastExit = new Date().toISOString();
      log(`${icon} EXIT  ${positionSide.padEnd(5)} ${symbol.padEnd(18)} [${reason}] price:${(pricePct*100).toFixed(3)}% margin:${pnlPct.toFixed(2)}% | PnL:$${pnl.toFixed(2)} | Daily:$${perf.dailyPnl.toFixed(2)} | W/L:${perf.wins}/${perf.losses}(${wr}%)`);
      return true;
    } else {
      log(`❌ EXIT FAIL   ${symbol} [${reason}] code=${r?.code} msg=${r?.msg}`);
      // FIX #2: remove from in-flight set on failure too (allow retry)
      closingPositions.delete(`${symbol}-${positionSide}`);
      return false;
    }
  } catch (e) {
    stats.errors++;
    log(`❌ EXIT ERROR  ${symbol}: ${e.message}`);
    closingPositions.delete(`${symbol}-${positionSide}`);  // FIX #2: allow retry
    return false;
  }
}

// ── Entry scan ─────────────────────────────────────────────────────────────────
let scanning = false;
async function scanEntry() {
  if (scanning) return;
  scanning = true;
  try {
    checkDailyReset();
    stats.lastScan = new Date().toISOString();

    if (checkCircuitBreaker()) return;

    const positions = await getOpenPositions();
    if (positions.length >= MAX_OPEN) return;

    // FIX #8: log when daily trade limit reached
    if (tradeToday >= MAX_DAILY) {
      log(`⏸  Daily trade limit ${MAX_DAILY} reached — no new entries until midnight reset`);
      return;
    }

    let bal = await getBalance();
    if (bal <= 0) { log(`⏸  Balance=0, skipping scan`); return; }

    const busy      = new Set(positions.map(p => p.symbol));
    let   openCount = positions.length;
    let   signals   = 0;

    const total = perf.wins + perf.losses;
    const wr    = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "n/a";
    log(`═ SCAN | bal=$${bal.toFixed(2)} | open=${openCount}/${MAX_OPEN} | today=${tradeToday} | dailyPnL:$${perf.dailyPnl.toFixed(2)}/$${DAILY_TARGET} | WR:${wr}`);

    for (const sym of WATCHLIST) {
      if (busy.has(sym))           continue;
      if (tradeToday >= MAX_DAILY) break;
      if (openCount  >= MAX_OPEN)  break;

      const cv  = await getCandles(sym);
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));

      const result = checkEntry(cv);
      if (!result) continue;

      const { signal, score, distPct, bodyPct, rsi: rsiVal } = result;
      signals++;

      const lastBar  = cv[cv.length - 2];
      const age      = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      const rsiStr   = rsiVal ? rsiVal.toFixed(1) : "n/a";
      log(`📊 SIGNAL ${signal.padEnd(5)} ${sym.padEnd(18)} score:${score}/8 | dist:${(distPct*100).toFixed(3)}% | body:${(bodyPct*100).toFixed(3)}% | RSI:${rsiStr} | age:${age}s`);

      const placed = await placeEntry(sym, signal, score, bal);
      if (placed) {
        openCount++;
        busy.add(sym);
        bal = await getBalance();  // refresh balance after each placed trade
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
      }
    }

    if (signals > 0) log(`═ SCAN DONE | signals=${signals} | trades_today=${tradeToday} | dailyPnL:$${perf.dailyPnl.toFixed(2)}`);
  } catch (e) {
    stats.errors++;
    log(`SCAN CRASH: ${e.message}`);
  } finally {
    scanning = false;
  }
}

// ── Exit monitor ───────────────────────────────────────────────────────────────
//
//  Per position, priority order:
//    1. Hard stop-loss    -3%  PnL on margin  → close immediately
//    2. Hard take-profit  +6%  PnL on margin  → close immediately (2:1 R:R)
//    3. Trailing stop     +3%  activate, trail 2% from peak
//    4. MA20 crossover    strategy signal
//
let polling = false;
async function pollExits() {
  if (polling) return;
  polling = true;
  try {
    // FIX #4: ensure peakPnl cleared at midnight even if no scan is running
    checkDailyReset();

    const positions = await getOpenPositions();
    if (!positions.length) return;

    for (const pos of positions) {
      const sym   = pos.symbol;
      const side  = pos.positionSide;
      const qty   = parseFloat(pos.positionAmt || 0);
      const entry = parseFloat(pos.avgPrice    || pos.entryPrice || 0);

      if (!qty || !["LONG", "SHORT"].includes(side)) continue;
      if (!entry) continue;

      const posKey = `${sym}-${side}`;

      // FIX #2: skip positions with in-flight close orders (prevent double-exit)
      if (closingPositions.has(posKey)) continue;

      // ── COMPUTE CURRENT PnL ─────────────────────────────────────────────────
      let pnlPct    = null;
      let pnlUsd    = null;
      let pnlSource = "";
      let livePrice = 0;

      // Method A: BingX unrealizedProfit / initialMargin (most accurate)
      const bxPnl    = parseFloat(pos.unrealizedProfit ?? "NaN");
      const bxMargin = parseFloat(pos.initialMargin    ?? pos.margin ?? "NaN");
      if (isFinite(bxPnl) && isFinite(bxMargin) && bxMargin > 0) {
        pnlPct    = bxPnl / bxMargin;
        pnlUsd    = bxPnl;
        pnlSource = "bingx";

        // FIX #3: fetch live price when method A is used so stop/TP/trail logs are accurate
        livePrice = await getLivePrice(sym);
      }

      // Method B: live price × leverage (fallback when BingX fields unavailable)
      if (pnlPct === null) {
        livePrice = await getLivePrice(sym);
        if (livePrice > 0) {
          const pp     = side === "LONG" ? (livePrice - entry) / entry : (entry - livePrice) / entry;
          pnlPct       = pp * LEVERAGE;
          const margin = Math.min(Math.abs(qty) * entry / LEVERAGE, MAX_MARGIN);
          pnlUsd       = pp * margin * LEVERAGE;
          pnlSource    = "live";
        }
      }

      if (pnlPct === null) {
        // Can't compute PnL — fall back to MA crossover check only
        const cv = await getCandles(sym);
        await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
        if (cv.length && checkExit(cv, side)) {
          log(`🔔 EXIT  ${side.padEnd(5)} ${sym.padEnd(18)} [MA20-cross] PnL:unknown`);
          closingPositions.add(posKey);  // FIX #2: mark in-flight
          await placeExit(sym, side, qty, entry, "MA20-cross");
          await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        }
        continue;
      }

      // Track peak PnL for trailing stop
      const prevPeak = peakPnl.get(posKey) ?? -Infinity;
      if (pnlPct > prevPeak) peakPnl.set(posKey, pnlPct);
      const peak = peakPnl.get(posKey);

      // ── 1. HARD STOP-LOSS ──────────────────────────────────────────────────
      if (pnlPct <= -STOP_LOSS_PCT) {
        log(`🛑 STOP-LOSS   ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPct*100).toFixed(2)}% $${(pnlUsd??0).toFixed(2)} [${pnlSource}]`);
        closingPositions.add(posKey);  // FIX #2: mark in-flight
        await placeExit(sym, side, qty, entry, "stop-loss", livePrice);
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        continue;
      }

      // ── 2. HARD TAKE-PROFIT ────────────────────────────────────────────────
      if (pnlPct >= TAKE_PROFIT_PCT) {
        log(`🎯 TAKE-PROFIT ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPct*100).toFixed(2)}% $${(pnlUsd??0).toFixed(2)}`);
        closingPositions.add(posKey);  // FIX #2: mark in-flight
        await placeExit(sym, side, qty, entry, "take-profit", livePrice);
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        continue;
      }

      // ── 3. TRAILING STOP ───────────────────────────────────────────────────
      if (peak >= TRAIL_ON_PCT && pnlPct <= peak - TRAIL_DIST_PCT) {
        log(`📉 TRAIL-STOP  ${side.padEnd(5)} ${sym.padEnd(18)} peak:${(peak*100).toFixed(2)}% now:${(pnlPct*100).toFixed(2)}%`);
        closingPositions.add(posKey);  // FIX #2: mark in-flight
        await placeExit(sym, side, qty, entry, "trail-stop", livePrice);
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        continue;
      }

      // ── 4. MA20 CROSSOVER ──────────────────────────────────────────────────
      const cv = await getCandles(sym);
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
      if (!cv.length) continue;
      if (!checkExit(cv, side)) continue;

      const lastBar = cv[cv.length - 2];
      const age     = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      log(`🔔 EXIT  ${side.padEnd(5)} ${sym.padEnd(18)} [MA20-cross] PnL:${(pnlPct*100).toFixed(2)}% | age:${age}s`);
      closingPositions.add(posKey);  // FIX #2: mark in-flight
      await placeExit(sym, side, qty, entry, "MA20-cross", livePrice);
      await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
    }
  } catch (e) {
    log(`EXIT POLL ERROR: ${e.message}`);
  } finally {
    polling = false;
  }
}

// ── HTTP dashboard ─────────────────────────────────────────────────────────────
http.createServer((req, res) => {
  if (req.url === "/log") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(stats.log.slice(-200).join("\n"));
    return;
  }
  const total    = perf.wins + perf.losses;
  const winRatio = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "0%";
  const progress = `${perf.dailyPnl.toFixed(2)} / $${DAILY_TARGET} (${((perf.dailyPnl / DAILY_TARGET) * 100).toFixed(1)}%)`;
  const paused   = winRatePauseUntil > Date.now()
    ? `circuit breaker — resumes in ${Math.ceil((winRatePauseUntil - Date.now()) / 60000)}min`
    : null;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status:    paused ? `⚠️ ${paused}` : "🟢 running 24/7",
    strategy:  `${RULES.strategy_name} v${RULES.version} | MA${MA_PERIOD}/SMA${SMA_PERIOD}/RSI${RSI_PERIOD} | ${TIMEFRAME}`,
    uptime:    Math.round(process.uptime()) + "s",
    trades:    stats.trades,
    today:     `${tradeToday}/${MAX_DAILY}`,
    errors:    stats.errors,
    lastScan:  stats.lastScan,
    lastExit:  stats.lastExit,
    perf: {
      wins:          perf.wins,
      losses:        perf.losses,
      winRatio,
      dailyPnl:      `$${progress}`,
      note:          "Target is informational — bot never halts on profit"
    },
    riskManagement: {
      stopLoss:       `-${STOP_LOSS_PCT * 100}% margin`,
      takeProfit:     `+${TAKE_PROFIT_PCT * 100}% margin`,
      trailActivate:  `+${TRAIL_ON_PCT * 100}% margin`,
      trailDistance:  `${TRAIL_DIST_PCT * 100}% from peak`,
      dailyTarget:    `$${DAILY_TARGET} (tracking only — no halt)`,
      circuitBreaker: paused || "inactive"
    },
    config: {
      timeframe:  TIMEFRAME,
      leverage:   `${LEVERAGE}x`,
      riskPct:    `${RISK_PCT * 100}%`,
      maxMargin:  `$${MAX_MARGIN}`,
      maxMaDist:  `${MAX_MA_DIST_PCT * 100}%`,
      watchlist:  WATCHLIST.length,
      blacklist:  BLACKLIST.size,
      scan:       `${SCAN_MS / 1000}s`,
      exit:       `${EXIT_POLL_MS / 1000}s`
    }
  }, null, 2));
}).listen(PORT, () => log(`🌐 Dashboard → http://localhost:${PORT}`));

// ── Boot ───────────────────────────────────────────────────────────────────────
await syncClock();
log(`🏦 ${RULES.strategy_name} v${RULES.version} — HEDGE FUND EDITION`);
log(`   Target      : $${DAILY_TARGET}/day | $${RULES.targets?.yearly_profit_usdt?.toLocaleString()}/year (tracking, no halt)`);
log(`   Timeframe   : ${TIMEFRAME} | MA${MA_PERIOD} | SMA${SMA_PERIOD} | RSI${RSI_PERIOD}`);
log(`   Entry       : within ${MAX_MA_DIST_PCT*100}% of MA20 | 2-candle window | RSI filter | scored`);
log(`   Stop-loss   : -${STOP_LOSS_PCT*100}%  Take-profit: +${TAKE_PROFIT_PCT*100}%  (R:R ${TAKE_PROFIT_PCT/STOP_LOSS_PCT}:1)`);
log(`   Trail stop  : activates at +${TRAIL_ON_PCT*100}%, trails ${TRAIL_DIST_PCT*100}% below peak`);
log(`   Circuit brk : win rate < ${WR_MIN*100}% (min ${WR_MIN_TRADES} trades) → pause ${WR_PAUSE_MS/60000}min`);
log(`   Watchlist   : ${WATCHLIST.length} symbols | ${BLACKLIST.size} blacklisted`);
log(`   Timing      : scan=${SCAN_MS/1000}s | exit=${EXIT_POLL_MS/1000}s | fetch=${FETCH_DELAY_MS}ms | order=${ORDER_DELAY_MS}ms`);
log(`   Qty formula : dynamic precision by price tier (BTC=4dp ETH=3dp SOL=2dp ...)`);

await scanEntry();
setInterval(scanEntry, SCAN_MS);
setInterval(pollExits, EXIT_POLL_MS);
