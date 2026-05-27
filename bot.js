/**
 * BingX Demo Trading Bot — MA20 Scalper v3.4 (Hedge Fund Edition)
 * Target: $200/day | $50,000/year
 *
 * TWO entry modes per scan:
 *
 *   A) TREND-FOLLOWING (primary, no volume required)
 *      LONG : MA20 > SMA200 + GREEN candle + prev RED  + close ≥ MA20 ± 0.5% + RSI < 70
 *      SHORT: MA20 < SMA200 + RED candle  + prev GREEN + close ≤ MA20 ± 0.5% + RSI > 30
 *
 *   B) COUNTER-TREND REVERSAL (requires ≥ 2× prior 20-bar avg volume)
 *      LONG : MA20 < SMA200 + same candle rules + volume surge → reversal BUY
 *      SHORT: MA20 > SMA200 + same candle rules + volume surge → reversal SELL
 *      Size : capped at 50% regardless of signal score
 *      Stop : -1.5% margin PnL (tighter than trend's -3%)
 *
 * Risk management:
 *   • Stop-loss     -3%  trend / -1.5% reversal  (hard, checked every 5s)
 *   • Take-profit   +6%  PnL on margin (2:1 R:R vs trend stop)
 *   • Trailing stop activates at +3%, trails 2% below peak
 *   • Win-rate circuit breaker: pause 30 min if WR < 40% (min 10 trades)
 *   • Signal quality scoring → position size 50% / 75% / 100% (trend only)
 *   • $200/day target — tracked only, NEVER halts trading
 *   • Bot runs 24/7 — no daily loss limit, no entry cap
 *
 * v3.4 fix:
 *   6. Slot-fill scan: whenever any exit fires, trigger a fresh scanEntry() 1.5s
 *      later so freed slots are filled almost immediately (was waiting up to 5s)
 *      scanEntry receives a reason tag ("interval" | "slot-fill") for clear logging
 *
 * v3.3 bug fixes:
 *   1. volAvg excludes curr bar (was inflating denominator, ratio was understated)
 *   2. Parallel candle fetch (5 concurrent) — scan drops from ~20s to ~4s
 *   3. pollExits 2-pass: stop/TP/trail first (no extra API), then parallel MA20 fetch
 *   4. livePrice only fetched when an exit actually triggers (was wasteful on every poll)
 *   5. getCandles 1 retry on failure (transient API errors no longer silently skip symbols)
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
const MA_PERIOD       = RULES.indicators.MA20.length;
const SMA_PERIOD      = RULES.indicators.SMA200.length;
const RSI_PERIOD      = 14;
const VOL_PERIOD      = 20;
const LEVERAGE        = RULES.position_sizing.leverage;
const RISK_PCT        = RULES.position_sizing.risk_pct;
const MAX_MARGIN      = RULES.position_sizing.max_margin;
const MIN_NOTIONAL    = RULES.position_sizing.min_notional;
const MAX_OPEN        = RULES.limits.max_open_positions;
const MAX_DAILY       = RULES.limits.max_trades_per_day;
const ORDER_DELAY_MS  = RULES.limits.api_delay_ms       || 500;
const FETCH_DELAY_MS  = RULES.limits.fetch_delay_ms     || 200;
const SCAN_MS         = RULES.limits.scan_interval_ms   || 5000;
const EXIT_POLL_MS    = RULES.limits.exit_poll_ms        || 5000;
const MIN_BODY_PCT    = 0.0002;
const MAX_MA_DIST_PCT = RULES.entry?.max_ma_distance_pct || 0.005;

// How many candle fetches run simultaneously (scan & exit MA check)
const CANDLE_CONCURRENCY = 5;

// ── Risk Management Config ─────────────────────────────────────────────────────
const rm              = RULES.risk_management || {};
const STOP_LOSS_PCT   = rm.stop_loss_pct           || RULES.limits.stop_loss_pct || 0.03;
const TAKE_PROFIT_PCT = rm.take_profit_pct         || 0.06;
const TRAIL_ON_PCT    = rm.trail_activate_pct      || 0.03;
const TRAIL_DIST_PCT  = rm.trail_distance_pct      || 0.02;
const DAILY_TARGET    = rm.daily_profit_target_usdt || 200;
const WR_MIN          = rm.win_rate_min             || 0.40;
const WR_MIN_TRADES   = rm.win_rate_min_trades      || 10;
const WR_PAUSE_MS     = (rm.win_rate_pause_minutes  || 30) * 60_000;

// ── Reversal Config ────────────────────────────────────────────────────────────
const rev = RULES.reversal_entry || {};
const REVERSAL_VOL_MULT  = rev.volume_multiplier || 2.0;
const REVERSAL_STOP_PCT  = rev.stop_loss_pct     || 0.015;
const REVERSAL_SIZE_MULT = rev.size_multiplier   || 0.50;

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
setInterval(syncClock, 60 * 60 * 1000);

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

// ── Shared state ───────────────────────────────────────────────────────────────
const peakPnl           = new Map();   // peak PnL per position (trailing stop)
const closingPositions  = new Set();   // in-flight closes (prevent double-exit)
const reversalPositions = new Set();   // counter-trend positions (-1.5% stop)
let   winRatePauseUntil = 0;
let   fillScanTimer     = null;        // FIX #6: scheduled slot-fill scan after exit

// ── Daily reset ────────────────────────────────────────────────────────────────
let tradeToday = 0;
let tradeDate  = new Date().toISOString().slice(0, 10);

function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== tradeDate) {
    tradeDate         = today;
    tradeToday        = 0;
    perf.dailyPnl     = 0;
    perf.wins         = 0;
    perf.losses       = 0;
    winRatePauseUntil = 0;
    peakPnl.clear();
    closingPositions.clear();
    reversalPositions.clear();
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
  log(`⚠️  CIRCUIT BREAKER — WR ${(wr*100).toFixed(1)}% < ${WR_MIN*100}% after ${total} trades → pause ${WR_PAUSE_MS/60000}min`);
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

// FIX #1: volAvg excludes BOTH forming bar ([-1]) AND curr bar ([-2])
//   OLD: slice(0,-1) included curr → curr's spike inflated avgVol → ratio understated
//   NEW: slice(0,-2) uses only prior bars → ratio is accurate
//   Example: 20 prior bars vol=1, curr vol=10
//     OLD: avg=(19+10)/20=1.45, ratio=10/1.45=6.9×  ← wrong
//     NEW: avg=19/19=1.0,       ratio=10/1.0 =10.0× ← correct
function volAvg(candles, period = VOL_PERIOD) {
  const prior = candles.slice(0, -2);           // exclude forming bar AND curr bar
  if (prior.length < period) return null;
  const vols = prior.slice(-period).map(c => c.volume || 0);
  return vols.reduce((a, b) => a + b, 0) / period;
}

// ── Signal quality score (3–8) → position size multiplier ─────────────────────
function signalScore(distPct, bodyPct, ma20, sma200) {
  let s = 0;
  if (distPct < 0.001)      s += 3; else if (distPct < 0.003) s += 2; else s += 1;
  if (bodyPct > 0.002)      s += 3; else if (bodyPct > 0.001) s += 2; else s += 1;
  const trendGap = sma200 > 0 ? Math.abs(ma20 - sma200) / sma200 : 0;
  if (trendGap > 0.005)     s += 2; else s += 1;
  return s;
}

function sizeMultiplier(score) {
  if (score >= 7) return 1.00;
  if (score >= 5) return 0.75;
  return 0.50;
}

// ── Entry signal ───────────────────────────────────────────────────────────────
function checkEntry(candles) {
  if (candles.length < SMA_PERIOD + 3) return null;

  const curr = candles[candles.length - 2];
  const prev = candles[candles.length - 3];

  const candleTime = curr.time < 1_000_000_000_000 ? curr.time * 1000 : curr.time;
  const signalAge  = bingxNow() - (candleTime + CANDLE_MS);
  if (signalAge < 0)              return null;
  if (signalAge >= CANDLE_MS * 2) return null;

  const cc     = candles.slice(0, -1).map(c => c.close);
  const ma20   = sma(cc, MA_PERIOD);
  const sma200 = sma(cc, SMA_PERIOD);
  const rsiVal = rsi(cc);
  if (!ma20 || !sma200) return null;

  const bullish = ma20 > sma200;
  const bearish = ma20 < sma200;
  if (!bullish && !bearish) return null;

  const bodyPct = Math.abs(curr.close - curr.open) / curr.open;
  if (bodyPct < MIN_BODY_PCT) return null;

  const distPct = Math.abs(curr.close - ma20) / ma20;
  if (distPct > MAX_MA_DIST_PCT) return null;

  const currGreen = curr.close > curr.open;
  const currRed   = curr.close < curr.open;
  const prevRed   = prev.close < prev.open;
  const prevGreen = prev.close > prev.open;

  const rsiOK_long  = !rsiVal || rsiVal < 70;
  const rsiOK_short = !rsiVal || rsiVal > 30;

  // FIX #1 applied: volAvg now uses prior bars only (curr excluded)
  const avgVol  = volAvg(candles);
  const currVol = curr.volume || 0;
  const volRatio = avgVol && currVol > 0 ? currVol / avgVol : null;

  let signal     = null;
  let isReversal = false;

  // MODE A: trend-following
  if (bullish && currGreen && prevRed   && curr.close >= ma20 && rsiOK_long)  signal = "LONG";
  if (bearish && currRed   && prevGreen && curr.close <= ma20 && rsiOK_short) signal = "SHORT";

  // MODE B: counter-trend reversal (needs ≥ 2× prior avg volume)
  if (!signal && avgVol && currVol >= avgVol * REVERSAL_VOL_MULT) {
    if (bearish && currGreen && prevRed   && curr.close >= ma20 && rsiOK_long)  { signal = "LONG";  isReversal = true; }
    if (bullish && currRed   && prevGreen && curr.close <= ma20 && rsiOK_short) { signal = "SHORT"; isReversal = true; }
  }

  if (!signal) return null;

  const score = signalScore(distPct, bodyPct, ma20, sma200);
  return { signal, score, distPct, bodyPct, rsi: rsiVal, ma20, sma200, isReversal, volRatio };
}

// ── Exit signal (no freshness guard — exits must always fire) ──────────────────
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
// FIX #5: 1 retry on transient failure (timeout, 429, etc.)
async function getCandles(symbol) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await GET("/openApi/swap/v3/quote/klines", {
        symbol, interval: TIMEFRAME, limit: SMA_PERIOD + 4
      });
      if (!Array.isArray(d?.data)) return [];
      const candles = d.data.map(c => {
        let t = Number(c.time);
        if (t > 0 && t < 1_000_000_000_000) t *= 1000;
        return {
          time:   t,
          open:   parseFloat(c.open),
          close:  parseFloat(c.close),
          volume: parseFloat(c.volume || 0)
        };
      });
      candles.sort((a, b) => a.time - b.time);
      return candles;
    } catch (e) {
      if (attempt === 0) await new Promise(r => setTimeout(r, 300));  // wait 300ms then retry
      else return [];
    }
  }
  return [];
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

// FIX #2: Parallel candle fetcher — max CANDLE_CONCURRENCY simultaneous requests
//   OLD: serial fetch, 29 symbols × ~700ms = ~20s scan time
//   NEW: 5 concurrent workers,  29 symbols / 5 = ~4s scan time
//   Entry latency: 30s+ → ~5–8s after candle close
async function fetchCandlesBatch(symbols) {
  const results = new Map();
  const queue   = [...symbols];

  async function worker() {
    while (true) {
      const sym = queue.shift();
      if (!sym) return;
      results.set(sym, await getCandles(sym));
      if (queue.length > 0) await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    }
  }

  const workers = Math.min(CANDLE_CONCURRENCY, symbols.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// ── Position sizing — dynamic decimal precision by price tier ──────────────────
function calcQty(bal, price, multiplier = 1.0) {
  if (!bal || !price) return 0;
  const margin   = Math.min(bal * RISK_PCT, MAX_MARGIN) * multiplier;
  const notional = margin * LEVERAGE;
  const rawQty   = notional / price;
  let decimals;
  if      (price >= 10_000) decimals = 4;
  else if (price >=  1_000) decimals = 3;
  else if (price >=     10) decimals = 2;
  else if (price >=      1) decimals = 1;
  else                      decimals = 0;
  return Math.floor(rawQty * (10 ** decimals)) / (10 ** decimals);
}

// ── Place entry ────────────────────────────────────────────────────────────────
async function placeEntry(symbol, signal, score, bal, isReversal = false) {
  try {
    const price = await getLivePrice(symbol);
    if (!price) { log(`SKIP ${symbol} — no live price`); return false; }

    const mult     = isReversal ? REVERSAL_SIZE_MULT : sizeMultiplier(score);
    const qty      = calcQty(bal, price, mult);
    const notional = qty * price;
    if (qty <= 0 || notional < MIN_NOTIONAL) {
      log(`SKIP ${symbol} qty=${qty} notional=${notional.toFixed(2)} < min`);
      return false;
    }

    const side         = signal === "LONG" ? "BUY" : "SELL";
    const positionSide = signal;
    const modeTag      = isReversal ? " ⚡REV" : "";
    const stopStr      = isReversal ? `-${REVERSAL_STOP_PCT*100}%` : `-${STOP_LOSS_PCT*100}%`;

    try { await POST("/openApi/swap/v2/trade/leverage", { symbol, side: signal, leverage: LEVERAGE }); } catch {}

    const r = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: qty
    });

    if (r?.code === 0) {
      stats.trades++;
      tradeToday++;
      if (isReversal) reversalPositions.add(`${symbol}-${signal}`);
      log(`✅ ENTRY${modeTag} ${signal.padEnd(5)} ${symbol.padEnd(18)} qty=${qty} @~${price} ${LEVERAGE}x | score=${score}/8(${(mult*100).toFixed(0)}%) stop=${stopStr} | today=${tradeToday}`);
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

      const total  = perf.wins + perf.losses;
      const wr     = total ? ((perf.wins / total) * 100).toFixed(1) : "0.0";
      const icon   = pnl >= 0 ? "✅" : "❌";
      const revTag = reversalPositions.has(`${symbol}-${positionSide}`) ? " ⚡REV" : "";

      peakPnl.delete(`${symbol}-${positionSide}`);
      closingPositions.delete(`${symbol}-${positionSide}`);
      reversalPositions.delete(`${symbol}-${positionSide}`);

      stats.lastExit = new Date().toISOString();
      log(`${icon} EXIT${revTag} ${positionSide.padEnd(5)} ${symbol.padEnd(18)} [${reason}] price:${(pricePct*100).toFixed(3)}% margin:${pnlPct.toFixed(2)}% | PnL:$${pnl.toFixed(2)} | Daily:$${perf.dailyPnl.toFixed(2)} | W/L:${perf.wins}/${perf.losses}(${wr}%)`);
      return true;
    } else {
      log(`❌ EXIT FAIL   ${symbol} [${reason}] code=${r?.code} msg=${r?.msg}`);
      closingPositions.delete(`${symbol}-${positionSide}`);
      return false;
    }
  } catch (e) {
    stats.errors++;
    log(`❌ EXIT ERROR  ${symbol}: ${e.message}`);
    closingPositions.delete(`${symbol}-${positionSide}`);
    return false;
  }
}

// ── FIX #6: Slot-fill scan ─────────────────────────────────────────────────────
// After any exit closes a position, trigger a fresh entry scan ~1.5s later.
// The 1.5s delay gives BingX time to process the close order before we call
// getOpenPositions() again. Built-in `scanning` guard prevents overlap.
// Only one fill scan is ever queued at a time — clearTimeout de-dupes.
function scheduleFillScan() {
  if (fillScanTimer) clearTimeout(fillScanTimer);
  fillScanTimer = setTimeout(() => {
    fillScanTimer = null;
    scanEntry("slot-fill");   // forward declaration OK — JS hoists the function
  }, 1500);
}

// ── Entry scan — Stage 1: parallel fetch | Stage 2: process signals ────────────
// FIX #2: parallel fetch drops total scan time from ~20s to ~4s
// reason = "interval"  → triggered by setInterval (normal 5s cadence)
//        = "slot-fill" → triggered by scheduleFillScan() after an exit
let scanning = false;
async function scanEntry(reason = "interval") {
  if (scanning) return;
  scanning = true;
  try {
    checkDailyReset();
    stats.lastScan = new Date().toISOString();

    if (checkCircuitBreaker()) return;

    const positions = await getOpenPositions();
    if (positions.length >= MAX_OPEN) return;

    if (tradeToday >= MAX_DAILY) {
      log(`⏸  Daily trade limit ${MAX_DAILY} reached — no new entries until midnight reset`);
      return;
    }

    let bal = await getBalance();
    if (bal <= 0) { log(`⏸  Balance=0, skipping scan`); return; }

    const busy    = new Set(positions.map(p => p.symbol));
    const toCheck = WATCHLIST.filter(s => !busy.has(s));
    if (!toCheck.length) return;

    let openCount  = positions.length;
    const slots    = MAX_OPEN - openCount;
    let signals    = 0;
    const total    = perf.wins + perf.losses;
    const wr       = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "n/a";
    const scanTag  = reason === "slot-fill" ? "🔄 SLOT-FILL" : "═ SCAN";
    log(`${scanTag} [${slots} slot${slots !== 1 ? "s" : ""} free] | bal=$${bal.toFixed(2)} | open=${openCount}/${MAX_OPEN} | checking=${toCheck.length} | today=${tradeToday} | PnL:$${perf.dailyPnl.toFixed(2)}/$${DAILY_TARGET} | WR:${wr}`);

    // ── Stage 1: fetch all candles in parallel ─────────────────────────────
    const scanStart  = Date.now();
    const candleMap  = await fetchCandlesBatch(toCheck);
    const fetchMs    = Date.now() - scanStart;

    // ── Stage 2: check signals and place entries (sequential) ──────────────
    for (const sym of toCheck) {
      if (tradeToday >= MAX_DAILY) break;
      if (openCount  >= MAX_OPEN)  break;
      if (busy.has(sym))           continue;

      const cv     = candleMap.get(sym) || [];
      const result = checkEntry(cv);
      if (!result) continue;

      const { signal, score, distPct, bodyPct, rsi: rsiVal, isReversal, volRatio } = result;
      signals++;

      const lastBar = cv[cv.length - 2];
      const age     = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      const rsiStr  = rsiVal  ? rsiVal.toFixed(1)    : "n/a";
      const volStr  = volRatio ? `${volRatio.toFixed(1)}x` : "n/a";
      const modeTag = isReversal ? " ⚡REVERSAL" : "";

      log(`📊 SIGNAL${modeTag} ${signal.padEnd(5)} ${sym.padEnd(18)} score:${score}/8 | dist:${(distPct*100).toFixed(3)}% | body:${(bodyPct*100).toFixed(3)}% | RSI:${rsiStr} | vol:${volStr} | age:${age}s`);

      const placed = await placeEntry(sym, signal, score, bal, isReversal);
      if (placed) {
        openCount++;
        busy.add(sym);
        bal = await getBalance();
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
      }
    }

    if (signals > 0) log(`═ SCAN DONE | fetch:${fetchMs}ms | signals=${signals} | trades_today=${tradeToday} | PnL:$${perf.dailyPnl.toFixed(2)}`);
  } catch (e) {
    stats.errors++;
    log(`SCAN CRASH: ${e.message}`);
  } finally {
    scanning = false;
  }
}

// ── Exit monitor — 2-pass design ───────────────────────────────────────────────
//
//  PASS 1 (fast — uses position data, no extra API calls):
//    Check stop-loss, take-profit, trailing-stop for every position.
//    livePrice only fetched when an exit actually triggers.
//
//  PASS 2 (parallel candle fetch):
//    For positions that didn't exit in pass 1, fetch candles in parallel
//    and check MA20 crossover.
//
//  FIX #3: eliminates serial candle fetch (was 20 × 700ms = 14s per poll)
//  FIX #4: livePrice not fetched unless exit condition is met
//  FIX #6: after any exit fires, scheduleFillScan() queues a slot-fill scan ~1.5s later
//
let polling = false;
async function pollExits() {
  if (polling) return;
  polling = true;
  let exitsFired = 0;   // FIX #6: count exits so we know whether to schedule fill scan
  try {
    checkDailyReset();

    const positions = await getOpenPositions();
    if (!positions.length) return;

    const needsMACheck = [];   // positions that didn't trigger in pass 1

    // ── PASS 1: Stop / Take-profit / Trailing-stop ─────────────────────────
    for (const pos of positions) {
      const sym   = pos.symbol;
      const side  = pos.positionSide;
      const qty   = parseFloat(pos.positionAmt || 0);
      const entry = parseFloat(pos.avgPrice    || pos.entryPrice || 0);

      if (!qty || !["LONG", "SHORT"].includes(side)) continue;
      if (!entry) continue;

      const posKey = `${sym}-${side}`;
      if (closingPositions.has(posKey)) continue;

      const isRev   = reversalPositions.has(posKey);
      const stopPct = isRev ? REVERSAL_STOP_PCT : STOP_LOSS_PCT;
      const revTag  = isRev ? " ⚡REV" : "";

      // Compute PnL from BingX position fields — no extra API call needed
      const bxPnl    = parseFloat(pos.unrealizedProfit ?? "NaN");
      const bxMargin = parseFloat(pos.initialMargin    ?? pos.margin ?? "NaN");

      if (!isFinite(bxPnl) || !isFinite(bxMargin) || bxMargin <= 0) {
        // BingX fields unavailable — queue for pass 2 (will use method B there)
        needsMACheck.push({ pos, pnlPct: null, pnlUsd: null, isRev, revTag });
        continue;
      }

      const pnlPct = bxPnl / bxMargin;
      const pnlUsd = bxPnl;

      // Update peak for trailing stop
      const prevPeak = peakPnl.get(posKey) ?? -Infinity;
      if (pnlPct > prevPeak) peakPnl.set(posKey, pnlPct);
      const peak = peakPnl.get(posKey);

      // FIX #4: livePrice only fetched when exit is about to fire
      let fired = false;

      if (pnlPct <= -stopPct) {
        const lp = await getLivePrice(sym);
        log(`🛑 STOP-LOSS${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPct*100).toFixed(2)}% $${pnlUsd.toFixed(2)} stop=${stopPct*100}%`);
        closingPositions.add(posKey);
        const ok = await placeExit(sym, side, qty, entry, `stop-loss${isRev?"-rev":""}`, lp);
        if (ok) exitsFired++;
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        fired = true;
      } else if (pnlPct >= TAKE_PROFIT_PCT) {
        const lp = await getLivePrice(sym);
        log(`🎯 TAKE-PROFIT${revTag} ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPct*100).toFixed(2)}% $${pnlUsd.toFixed(2)}`);
        closingPositions.add(posKey);
        const ok = await placeExit(sym, side, qty, entry, `take-profit${isRev?"-rev":""}`, lp);
        if (ok) exitsFired++;
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        fired = true;
      } else if (peak >= TRAIL_ON_PCT && pnlPct <= peak - TRAIL_DIST_PCT) {
        const lp = await getLivePrice(sym);
        log(`📉 TRAIL-STOP${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} peak:${(peak*100).toFixed(2)}% now:${(pnlPct*100).toFixed(2)}%`);
        closingPositions.add(posKey);
        const ok = await placeExit(sym, side, qty, entry, `trail-stop${isRev?"-rev":""}`, lp);
        if (ok) exitsFired++;
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        fired = true;
      }

      if (!fired) needsMACheck.push({ pos, pnlPct, pnlUsd, isRev, revTag });
    }

    if (!needsMACheck.length) return;

    // ── PASS 2: MA20 crossover — parallel candle fetch ─────────────────────
    const maSymbols = needsMACheck.map(x => x.pos.symbol);
    const candleMap = await fetchCandlesBatch(maSymbols);

    for (const { pos, pnlPct, isRev, revTag } of needsMACheck) {
      const sym   = pos.symbol;
      const side  = pos.positionSide;
      const qty   = parseFloat(pos.positionAmt || 0);
      const entry = parseFloat(pos.avgPrice    || pos.entryPrice || 0);
      const posKey = `${sym}-${side}`;

      if (closingPositions.has(posKey)) continue;  // closed in pass 1

      const cv = candleMap.get(sym) || [];

      // For positions without BingX PnL data, compute via method B before MA check
      if (pnlPct === null && cv.length) {
        const lp = await getLivePrice(sym);
        if (lp > 0) {
          const pp       = side === "LONG" ? (lp - entry)/entry : (entry - lp)/entry;
          const pnlPctB  = pp * LEVERAGE;
          const margin   = Math.min(Math.abs(qty) * entry / LEVERAGE, MAX_MARGIN);
          const pnlUsdB  = pp * margin * LEVERAGE;
          const stopPctB = isRev ? REVERSAL_STOP_PCT : STOP_LOSS_PCT;
          const prevPeak = peakPnl.get(posKey) ?? -Infinity;
          if (pnlPctB > prevPeak) peakPnl.set(posKey, pnlPctB);
          const peak = peakPnl.get(posKey);

          if (pnlPctB <= -stopPctB) {
            log(`🛑 STOP-LOSS${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPctB*100).toFixed(2)}% [live]`);
            closingPositions.add(posKey);
            const ok = await placeExit(sym, side, qty, entry, `stop-loss${isRev?"-rev":""}`, lp);
            if (ok) exitsFired++;
            await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
            continue;
          }
          if (pnlPctB >= TAKE_PROFIT_PCT) {
            log(`🎯 TAKE-PROFIT${revTag} ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPctB*100).toFixed(2)}% [live]`);
            closingPositions.add(posKey);
            const ok = await placeExit(sym, side, qty, entry, `take-profit${isRev?"-rev":""}`, lp);
            if (ok) exitsFired++;
            await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
            continue;
          }
          if (peak >= TRAIL_ON_PCT && pnlPctB <= peak - TRAIL_DIST_PCT) {
            log(`📉 TRAIL-STOP${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} peak:${(peak*100).toFixed(2)}% now:${(pnlPctB*100).toFixed(2)}% [live]`);
            closingPositions.add(posKey);
            const ok = await placeExit(sym, side, qty, entry, `trail-stop${isRev?"-rev":""}`, lp);
            if (ok) exitsFired++;
            await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
            continue;
          }
        }
      }

      // MA20 crossover check (always runs if no prior exit)
      if (!cv.length || !checkExit(cv, side)) continue;

      const lastBar = cv[cv.length - 2];
      const age     = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      const pnlStr  = pnlPct !== null ? `${(pnlPct*100).toFixed(2)}%` : "n/a";
      log(`🔔 EXIT${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} [MA20-cross] PnL:${pnlStr} | age:${age}s`);
      closingPositions.add(posKey);
      const lp = await getLivePrice(sym);
      const ok  = await placeExit(sym, side, qty, entry, `MA20-cross${isRev?"-rev":""}`, lp);
      if (ok) exitsFired++;
      await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
    }
  } catch (e) {
    log(`EXIT POLL ERROR: ${e.message}`);
  } finally {
    // FIX #6: if any position closed, schedule an immediate slot-fill scan
    if (exitsFired > 0) {
      log(`🔄 ${exitsFired} slot${exitsFired !== 1 ? "s" : ""} freed — slot-fill scan in 1.5s`);
      scheduleFillScan();
    }
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
      dailyPnl:      `$${perf.dailyPnl.toFixed(2)} / $${DAILY_TARGET}`,
      progress:      `${((perf.dailyPnl / DAILY_TARGET) * 100).toFixed(1)}%`
    },
    entryModes: {
      trend_following:  "LONG if MA20>SMA200 | SHORT if MA20<SMA200",
      counter_reversal: `LONG if MA20<SMA200 + vol≥${REVERSAL_VOL_MULT}x prior avg | SHORT if MA20>SMA200 + vol≥${REVERSAL_VOL_MULT}x prior avg`,
      reversal_size:    `${REVERSAL_SIZE_MULT * 100}% (fixed)`,
      reversal_stop:    `-${REVERSAL_STOP_PCT * 100}% vs trend -${STOP_LOSS_PCT * 100}%`
    },
    riskManagement: {
      stopLoss_trend:    `-${STOP_LOSS_PCT * 100}%`,
      stopLoss_reversal: `-${REVERSAL_STOP_PCT * 100}%`,
      takeProfit:        `+${TAKE_PROFIT_PCT * 100}%`,
      trailActivate:     `+${TRAIL_ON_PCT * 100}%`,
      trailDistance:     `${TRAIL_DIST_PCT * 100}% from peak`,
      circuitBreaker:    paused || "inactive"
    },
    performance: {
      scanConcurrency:   `${CANDLE_CONCURRENCY} parallel workers`,
      entryLatency:      `~4s fetch + signal check (was ~20s serial)`,
      exitLatency:       "pass1: instant (position data) | pass2: parallel MA fetch",
      slotFill:          "immediate — slot-fill scan fires 1.5s after any exit"
    },
    config: {
      timeframe: TIMEFRAME, leverage: `${LEVERAGE}x`,
      riskPct: `${RISK_PCT*100}%`, maxMargin: `$${MAX_MARGIN}`,
      maxMaDist: `${MAX_MA_DIST_PCT*100}%`,
      watchlist: WATCHLIST.length, blacklist: BLACKLIST.size,
      scan: `${SCAN_MS/1000}s`, exit: `${EXIT_POLL_MS/1000}s`
    }
  }, null, 2));
}).listen(PORT, () => log(`🌐 Dashboard → http://localhost:${PORT}`));

// ── Boot ───────────────────────────────────────────────────────────────────────
await syncClock();
log(`🏦 ${RULES.strategy_name} v${RULES.version} — HEDGE FUND EDITION`);
log(`   Target       : $${DAILY_TARGET}/day | $${RULES.targets?.yearly_profit_usdt?.toLocaleString()}/year`);
log(`   Timeframe    : ${TIMEFRAME} | MA${MA_PERIOD} | SMA${SMA_PERIOD} | RSI${RSI_PERIOD}`);
log(`   ── TREND ENTRY    within ${MAX_MA_DIST_PCT*100}% MA20 | 2-candle window | RSI | scored size`);
log(`   ── REVERSAL ENTRY vol ≥ ${REVERSAL_VOL_MULT}× prior avg | 50% size | stop -${REVERSAL_STOP_PCT*100}%`);
log(`   Stop-loss    : -${STOP_LOSS_PCT*100}% trend / -${REVERSAL_STOP_PCT*100}% reversal`);
log(`   Take-profit  : +${TAKE_PROFIT_PCT*100}%  |  Trail: +${TRAIL_ON_PCT*100}% activates, -${TRAIL_DIST_PCT*100}% below peak`);
log(`   Circuit brk  : WR < ${WR_MIN*100}% (min ${WR_MIN_TRADES} trades) → pause ${WR_PAUSE_MS/60000}min`);
log(`   Watchlist    : ${WATCHLIST.length} symbols | ${BLACKLIST.size} blacklisted`);
log(`   Scan speed   : ${CANDLE_CONCURRENCY} concurrent workers | fetch≤4s | entry latency ~5–8s after close`);
log(`   Exit speed   : pass1 instant (position data) | pass2 parallel MA20 fetch`);
log(`   Slot fill    : immediate — slot-fill scan triggers 1.5s after any exit closes a position`);

await scanEntry();
setInterval(scanEntry, SCAN_MS);
setInterval(pollExits, EXIT_POLL_MS);
