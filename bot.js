/**
 * BingX Demo Trading Bot — MA Swing Trader v3.5 (Hedge Fund Edition)
 * Target: $200/day | $50,000/year
 *
 * STRATEGY: Swing trading on 1m candles with 5m multi-timeframe (MTF) bias
 *
 * TWO entry modes per scan:
 *
 *   A) TREND-FOLLOWING (primary, no volume required)
 *      LONG : MA20 > SMA200 (1m) + 5m close ≥ 5m-MA20 (MTF) + GREEN candle
 *             + prev RED + close ≥ MA20 ± 0.5% + RSI < 70
 *      SHORT: MA20 < SMA200 (1m) + 5m close ≤ 5m-MA20 (MTF) + RED candle
 *             + prev GREEN + close ≤ MA20 ± 0.5% + RSI > 30
 *
 *   B) COUNTER-TREND REVERSAL (requires ≥ 2× prior 20-bar avg volume)
 *      LONG : MA20 < SMA200 + same candle rules + volume surge → reversal BUY
 *      SHORT: MA20 > SMA200 + same candle rules + volume surge → reversal SELL
 *      MTF  : skipped — reversals are counter-trend by design
 *      Size : capped at 50% regardless of signal score
 *      Stop : -1.5% margin PnL (tighter than trend's -3%)
 *
 * AI Agent behaviors:
 *   • Multi-indicator confluence scoring (distance + body + trend gap + MTF + RSI)
 *   • Smart re-entry cooldown: 5-min block on any symbol after a stop-loss fires
 *   • Signal quality score drives position size (50% / 75% / 100%)
 *
 * Risk management:
 *   • Stop-loss      -3%  trend / -1.5% reversal  (hard, checked every 5s)
 *   • Take-profit    +8%  PnL on margin (swing target — was +6%)
 *   • Trailing stop  activates at +4%, trails 2% below peak (was +3%/2%)
 *   • Win-rate circuit breaker: pause 30 min if WR < 40% (min 10 trades)
 *   • $200/day target — tracked only, NEVER halts trading
 *   • Bot runs 24/7 — no daily loss limit, no entry cap
 *
 * v3.5 changes (Scalper → Swing Trader):
 *   1. Multi-timeframe (MTF): 5m MA20 must align with 1m signal for trend entries
 *   2. Take profit raised +6% → +8% | Trail activates +3% → +4% (longer holds)
 *   3. Smart re-entry cooldown: 5-min block per symbol after stop-loss fires
 *   4. Signal scoring enhanced: MTF bonus (+1) + RSI positioning bonus (+1) → max 10
 *   5. Slot-fill scan: immediate re-scan 1.5s after any exit frees a slot (v3.4)
 *
 * v3.4 fix:
 *   6. Slot-fill scan: whenever any exit fires, trigger fresh scanEntry() 1.5s later
 *
 * v3.3 bug fixes:
 *   7.  volAvg excludes curr bar (was inflating denominator, ratio was understated)
 *   8.  Parallel candle fetch (5 concurrent) — scan drops from ~20s to ~4s
 *   9.  pollExits 2-pass: stop/TP/trail first (no extra API), then parallel MA20 fetch
 *   10. livePrice only fetched when an exit actually triggers
 *   11. getCandles 1 retry on failure
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
const TIMEFRAME       = RULES.timeframe;                  // "1m" — entry trigger
const TIMEFRAME_HTF   = "5m";                             // MTF bias timeframe
const MA_PERIOD       = RULES.indicators.MA20.length;     // 20
const SMA_PERIOD      = RULES.indicators.SMA200.length;   // 200
const HTF_MA_PERIOD   = 20;                               // 5m MA20 for bias
const HTF_LIMIT       = 25;                               // candle limit for 5m fetch
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

// How many candle fetches run simultaneously
const CANDLE_CONCURRENCY     = 5;    // 1m entries + exit MA check
const CANDLE_CONCURRENCY_HTF = 3;    // 5m HTF bias (lower to avoid rate limits)

// ── Risk Management Config ─────────────────────────────────────────────────────
const rm              = RULES.risk_management || {};
const STOP_LOSS_PCT   = rm.stop_loss_pct           || 0.03;
const TAKE_PROFIT_PCT = rm.take_profit_pct         || 0.08;   // +8% (swing target)
const TRAIL_ON_PCT    = rm.trail_activate_pct      || 0.04;   // activates at +4%
const TRAIL_DIST_PCT  = rm.trail_distance_pct      || 0.02;   // trails 2%
const DAILY_TARGET    = rm.daily_profit_target_usdt || 200;
const WR_MIN          = rm.win_rate_min             || 0.40;
const WR_MIN_TRADES   = rm.win_rate_min_trades      || 10;
const WR_PAUSE_MS     = (rm.win_rate_pause_minutes  || 30) * 60_000;
const COOLDOWN_MS     = (rm.stop_cooldown_minutes   || 5)  * 60_000;  // 5-min re-entry block

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
const stopCooldowns     = new Map();   // symbol → cooldown end timestamp (5-min after stop-loss)
let   winRatePauseUntil = 0;
let   fillScanTimer     = null;        // scheduled slot-fill scan after exit

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
    stopCooldowns.clear();
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

// volAvg excludes BOTH forming bar ([-1]) AND curr bar ([-2]) — curr excluded so
// it doesn't inflate its own baseline (a 10× spike must read as 10×, not 6.9×)
function volAvg(candles, period = VOL_PERIOD) {
  const prior = candles.slice(0, -2);
  if (prior.length < period) return null;
  const vols = prior.slice(-period).map(c => c.volume || 0);
  return vols.reduce((a, b) => a + b, 0) / period;
}

// ── Signal quality score (max 10) → position size multiplier ──────────────────
//   Points breakdown:
//     Distance from MA20 : 1–3 pts (closer = better)
//     Body size (momentum): 1–3 pts (bigger = stronger conviction)
//     Trend gap (MA20 vs SMA200): 1–2 pts (wider = stronger trend)
//     MTF confirmation   : +1 pt  (5m MA20 agrees with signal direction)
//     RSI positioning    : +1 pt  (RSI 40–60 = not extended, clean entry zone)
function signalScore(distPct, bodyPct, ma20, sma200, rsiVal, mtfConfirmed) {
  let s = 0;

  // Distance from MA20 (closest bounce = highest score)
  if      (distPct < 0.001) s += 3;
  else if (distPct < 0.003) s += 2;
  else                      s += 1;

  // Body size (momentum strength)
  if      (bodyPct > 0.002) s += 3;
  else if (bodyPct > 0.001) s += 2;
  else                      s += 1;

  // Trend gap strength (further apart = cleaner trend)
  const trendGap = sma200 > 0 ? Math.abs(ma20 - sma200) / sma200 : 0;
  if (trendGap > 0.005) s += 2; else s += 1;

  // MTF confirmation bonus (+1 if 5m MA20 aligns with signal direction)
  if (mtfConfirmed) s += 1;

  // RSI in ideal zone (+1 if RSI between 40–60, not extended)
  if (rsiVal && rsiVal >= 40 && rsiVal <= 60) s += 1;

  return s;
}

function sizeMultiplier(score) {
  if (score >= 8) return 1.00;   // strong confluence
  if (score >= 6) return 0.75;   // moderate confluence
  return 0.50;                   // weak confluence
}

// ── Entry signal ───────────────────────────────────────────────────────────────
// candles1m : 1m candle array (primary signals)
// candles5m : 5m candle array (MTF bias filter, optional)
function checkEntry(candles1m, candles5m = null) {
  if (candles1m.length < SMA_PERIOD + 3) return null;

  const curr = candles1m[candles1m.length - 2];  // last closed bar
  const prev = candles1m[candles1m.length - 3];  // bar before last closed

  // Freshness check — signal must be from last 2 closed bars
  const candleTime = curr.time < 1_000_000_000_000 ? curr.time * 1000 : curr.time;
  const signalAge  = bingxNow() - (candleTime + CANDLE_MS);
  if (signalAge < 0)              return null;  // bar not yet closed
  if (signalAge >= CANDLE_MS * 2) return null;  // too old (3rd+ candle)

  // 1m indicators (computed over closed bars only — exclude forming bar)
  const cc     = candles1m.slice(0, -1).map(c => c.close);
  const ma20   = sma(cc, MA_PERIOD);
  const sma200 = sma(cc, SMA_PERIOD);
  const rsiVal = rsi(cc);
  if (!ma20 || !sma200) return null;

  const bullish = ma20 > sma200;
  const bearish = ma20 < sma200;
  if (!bullish && !bearish) return null;  // MA20 == SMA200 → no clear trend

  // Minimum body size (filter noise / doji candles)
  const bodyPct = Math.abs(curr.close - curr.open) / curr.open;
  if (bodyPct < MIN_BODY_PCT) return null;

  // Proximity to MA20 (no chasing — must be within 0.5%)
  const distPct = Math.abs(curr.close - ma20) / ma20;
  if (distPct > MAX_MA_DIST_PCT) return null;

  const currGreen = curr.close > curr.open;
  const currRed   = curr.close < curr.open;
  const prevRed   = prev.close < prev.open;
  const prevGreen = prev.close > prev.open;

  const rsiOK_long  = !rsiVal || rsiVal < 70;
  const rsiOK_short = !rsiVal || rsiVal > 30;

  // Volume for reversal check (excludes curr bar from baseline)
  const avgVol  = volAvg(candles1m);
  const currVol = curr.volume || 0;
  const volRatio = avgVol && currVol > 0 ? currVol / avgVol : null;

  let signal     = null;
  let isReversal = false;

  // MODE A: trend-following
  if (bullish && currGreen && prevRed   && curr.close >= ma20 && rsiOK_long)  signal = "LONG";
  if (bearish && currRed   && prevGreen && curr.close <= ma20 && rsiOK_short) signal = "SHORT";

  // MODE B: counter-trend reversal (≥ 2× prior avg volume)
  if (!signal && avgVol && currVol >= avgVol * REVERSAL_VOL_MULT) {
    if (bearish && currGreen && prevRed   && curr.close >= ma20 && rsiOK_long)  { signal = "LONG";  isReversal = true; }
    if (bullish && currRed   && prevGreen && curr.close <= ma20 && rsiOK_short) { signal = "SHORT"; isReversal = true; }
  }

  if (!signal) return null;

  // ── MTF filter: 5m MA20 bias check (trend-following entries only) ──────────
  // Reversals are counter-trend by definition — skip MTF for them
  let mtfConfirmed = false;
  let mtfTag       = "n/a";

  if (!isReversal && candles5m && candles5m.length >= HTF_MA_PERIOD + 2) {
    const cc5m    = candles5m.slice(0, -1).map(c => c.close);  // exclude forming 5m bar
    const ma5m    = sma(cc5m, HTF_MA_PERIOD);
    const last5m  = cc5m[cc5m.length - 1];

    if (ma5m) {
      if (signal === "LONG"  && last5m < ma5m) return null;  // 5m bearish → skip LONG entry
      if (signal === "SHORT" && last5m > ma5m) return null;  // 5m bullish → skip SHORT entry
      mtfConfirmed = true;
      mtfTag       = "✅5m";
    }
  } else if (!isReversal) {
    // 5m data unavailable — allow entry but note MTF unchecked
    mtfTag = "⚡no5m";
  }

  const score = signalScore(distPct, bodyPct, ma20, sma200, rsiVal, mtfConfirmed);
  return { signal, score, distPct, bodyPct, rsi: rsiVal, ma20, sma200, isReversal, volRatio, mtfConfirmed, mtfTag };
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
// 1 retry on transient failure (timeout, 429, network blip)
async function getCandles(symbol, interval = TIMEFRAME, limit = SMA_PERIOD + 4) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await GET("/openApi/swap/v3/quote/klines", { symbol, interval, limit });
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
      if (attempt === 0) await new Promise(r => setTimeout(r, 300));
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

// Parallel candle fetcher — N concurrent workers
// interval = "1m" for entry signals, "5m" for MTF bias
// concurrency defaults to CANDLE_CONCURRENCY for 1m, CANDLE_CONCURRENCY_HTF for 5m
async function fetchCandlesBatch(symbols, interval = TIMEFRAME, limit = SMA_PERIOD + 4) {
  const results    = new Map();
  const queue      = [...symbols];
  const concurrent = interval === TIMEFRAME_HTF ? CANDLE_CONCURRENCY_HTF : CANDLE_CONCURRENCY;

  async function worker() {
    while (true) {
      const sym = queue.shift();
      if (!sym) return;
      results.set(sym, await getCandles(sym, interval, limit));
      if (queue.length > 0) await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
    }
  }

  const workers = Math.min(concurrent, symbols.length);
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
      log(`✅ SWING${modeTag} ${signal.padEnd(5)} ${symbol.padEnd(18)} qty=${qty} @~${price} ${LEVERAGE}x | score=${score}/10(${(mult*100).toFixed(0)}%) stop=${stopStr} tp=+${TAKE_PROFIT_PCT*100}% | today=${tradeToday}`);
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

// ── Slot-fill scan ─────────────────────────────────────────────────────────────
// After any exit closes a position, trigger a fresh entry scan ~1.5s later.
// 1.5s gives BingX time to process the close before getOpenPositions() runs.
// clearTimeout de-dupes — rapid multi-exit polls queue exactly ONE fill scan.
function scheduleFillScan() {
  if (fillScanTimer) clearTimeout(fillScanTimer);
  fillScanTimer = setTimeout(() => {
    fillScanTimer = null;
    scanEntry("slot-fill");
  }, 1500);
}

// ── Entry scan ─────────────────────────────────────────────────────────────────
// Stage 1 : fetch ALL 1m + 5m candles in parallel
// Stage 2 : evaluate signals, apply cooldown guard, place entries
//
// reason = "interval"  → 5s setInterval cadence
//        = "slot-fill" → triggered after an exit frees a slot
//        = "boot"      → initial scan on startup
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
    let blocked    = 0;
    const total    = perf.wins + perf.losses;
    const wr       = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "n/a";
    const scanTag  = reason === "slot-fill" ? "🔄 SLOT-FILL" : (reason === "boot" ? "🚀 BOOT-SCAN" : "═ SCAN");
    log(`${scanTag} [${slots} slot${slots !== 1 ? "s" : ""} free] | bal=$${bal.toFixed(2)} | open=${openCount}/${MAX_OPEN} | checking=${toCheck.length} | today=${tradeToday} | PnL:$${perf.dailyPnl.toFixed(2)}/$${DAILY_TARGET} | WR:${wr}`);

    // ── Stage 1: fetch 1m AND 5m candles in parallel ───────────────────────
    const scanStart = Date.now();
    const [candleMap1m, candleMap5m] = await Promise.all([
      fetchCandlesBatch(toCheck, TIMEFRAME,     SMA_PERIOD + 4),
      fetchCandlesBatch(toCheck, TIMEFRAME_HTF, HTF_LIMIT)
    ]);
    const fetchMs = Date.now() - scanStart;

    // ── Stage 2: evaluate signals and place entries ────────────────────────
    for (const sym of toCheck) {
      if (tradeToday >= MAX_DAILY) break;
      if (openCount  >= MAX_OPEN)  break;
      if (busy.has(sym))           continue;

      const cv1m = candleMap1m.get(sym) || [];
      const cv5m = candleMap5m.get(sym) || [];

      const result = checkEntry(cv1m, cv5m.length >= HTF_MA_PERIOD + 2 ? cv5m : null);
      if (!result) continue;

      signals++;

      // ── AI: Cooldown guard — skip symbol for 5 min after stop-loss ──────
      if (stopCooldowns.has(sym)) {
        const cooldownEnd = stopCooldowns.get(sym);
        if (Date.now() < cooldownEnd) {
          const remaining = Math.ceil((cooldownEnd - Date.now()) / 1000);
          blocked++;
          log(`⏸  COOLDOWN   ${sym.padEnd(18)} signal=${result.signal} blocked — ${remaining}s remaining (post-stop cooldown)`);
          continue;
        }
        stopCooldowns.delete(sym);
      }

      const { signal, score, distPct, bodyPct, rsi: rsiVal, isReversal, volRatio, mtfTag } = result;
      const lastBar = cv1m[cv1m.length - 2];
      const age     = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      const rsiStr  = rsiVal  ? rsiVal.toFixed(1)    : "n/a";
      const volStr  = volRatio ? `${volRatio.toFixed(1)}x` : "n/a";
      const modeTag = isReversal ? " ⚡REVERSAL" : "";

      log(`📊 SIGNAL${modeTag} ${signal.padEnd(5)} ${sym.padEnd(18)} score:${score}/10 | dist:${(distPct*100).toFixed(3)}% | body:${(bodyPct*100).toFixed(3)}% | RSI:${rsiStr} | vol:${volStr} | MTF:${mtfTag} | age:${age}s`);

      const placed = await placeEntry(sym, signal, score, bal, isReversal);
      if (placed) {
        openCount++;
        busy.add(sym);
        bal = await getBalance();
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
      }
    }

    if (signals > 0) log(`═ SCAN DONE | fetch:${fetchMs}ms(1m+5m) | signals=${signals} blocked=${blocked} | trades_today=${tradeToday} | PnL:$${perf.dailyPnl.toFixed(2)}`);
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
//    Stop-loss, take-profit, trailing-stop — all from BingX position fields.
//    livePrice fetched only when exit condition is actually met.
//    Stop-loss fires → set 5-min cooldown on that symbol.
//
//  PASS 2 (parallel candle fetch):
//    MA20 crossover check for remaining positions.
//    Parallel 1m candle fetch for all pending symbols.
//
//  After all passes: if any exit fired → scheduleFillScan() for slot-fill.
//
let polling = false;
async function pollExits() {
  if (polling) return;
  polling = true;
  let exitsFired = 0;
  try {
    checkDailyReset();

    const positions = await getOpenPositions();
    if (!positions.length) return;

    const needsMACheck = [];

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

      const bxPnl    = parseFloat(pos.unrealizedProfit ?? "NaN");
      const bxMargin = parseFloat(pos.initialMargin    ?? pos.margin ?? "NaN");

      if (!isFinite(bxPnl) || !isFinite(bxMargin) || bxMargin <= 0) {
        needsMACheck.push({ pos, pnlPct: null, pnlUsd: null, isRev, revTag });
        continue;
      }

      const pnlPct = bxPnl / bxMargin;
      const pnlUsd = bxPnl;

      const prevPeak = peakPnl.get(posKey) ?? -Infinity;
      if (pnlPct > prevPeak) peakPnl.set(posKey, pnlPct);
      const peak = peakPnl.get(posKey);

      let fired = false;

      if (pnlPct <= -stopPct) {
        const lp = await getLivePrice(sym);
        log(`🛑 STOP-LOSS${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPct*100).toFixed(2)}% $${pnlUsd.toFixed(2)} stop=${stopPct*100}%`);
        closingPositions.add(posKey);
        const ok = await placeExit(sym, side, qty, entry, `stop-loss${isRev?"-rev":""}`, lp);
        if (ok) {
          exitsFired++;
          // AI: set 5-min cooldown so bot doesn't immediately re-enter after a loss
          stopCooldowns.set(sym, Date.now() + COOLDOWN_MS);
          log(`⏸  COOLDOWN SET ${sym} — ${COOLDOWN_MS/60000}min re-entry block after stop-loss`);
        }
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
    const candleMap = await fetchCandlesBatch(maSymbols, TIMEFRAME, SMA_PERIOD + 4);

    for (const { pos, pnlPct, isRev, revTag } of needsMACheck) {
      const sym    = pos.symbol;
      const side   = pos.positionSide;
      const qty    = parseFloat(pos.positionAmt || 0);
      const entry  = parseFloat(pos.avgPrice    || pos.entryPrice || 0);
      const posKey = `${sym}-${side}`;

      if (closingPositions.has(posKey)) continue;

      const cv = candleMap.get(sym) || [];

      // Method B fallback: when BingX PnL fields unavailable, compute from live price
      if (pnlPct === null && cv.length) {
        const lp = await getLivePrice(sym);
        if (lp > 0) {
          const pp       = side === "LONG" ? (lp - entry)/entry : (entry - lp)/entry;
          const pnlPctB  = pp * LEVERAGE;
          const margin   = Math.min(Math.abs(qty) * entry / LEVERAGE, MAX_MARGIN);
          const stopPctB = isRev ? REVERSAL_STOP_PCT : STOP_LOSS_PCT;
          const prevPeak = peakPnl.get(posKey) ?? -Infinity;
          if (pnlPctB > prevPeak) peakPnl.set(posKey, pnlPctB);
          const peak = peakPnl.get(posKey);

          if (pnlPctB <= -stopPctB) {
            log(`🛑 STOP-LOSS${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPctB*100).toFixed(2)}% [live]`);
            closingPositions.add(posKey);
            const ok = await placeExit(sym, side, qty, entry, `stop-loss${isRev?"-rev":""}`, lp);
            if (ok) {
              exitsFired++;
              stopCooldowns.set(sym, Date.now() + COOLDOWN_MS);
              log(`⏸  COOLDOWN SET ${sym} — ${COOLDOWN_MS/60000}min re-entry block after stop-loss`);
            }
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

      // MA20 crossover check
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

  const total      = perf.wins + perf.losses;
  const winRatio   = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "0%";
  const paused     = winRatePauseUntil > Date.now()
    ? `circuit breaker — resumes in ${Math.ceil((winRatePauseUntil - Date.now()) / 60000)}min`
    : null;
  const cooldowns  = [...stopCooldowns.entries()]
    .filter(([, end]) => Date.now() < end)
    .map(([sym, end]) => `${sym}:${Math.ceil((end - Date.now()) / 1000)}s`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status:    paused ? `⚠️ ${paused}` : "🟢 running 24/7",
    strategy:  `${RULES.strategy_name} v${RULES.version} | MA${MA_PERIOD}/SMA${SMA_PERIOD}/RSI${RSI_PERIOD} | ${TIMEFRAME} entries | ${TIMEFRAME_HTF} MTF bias`,
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
    aiAgent: {
      mtf_bias:         `5m MA${HTF_MA_PERIOD} confirms 1m trend direction before entry`,
      confluence_score: "max 10pts: distance(1-3) + body(1-3) + trend-gap(1-2) + MTF(+1) + RSI-zone(+1)",
      size_tiers:       "≥8=100% | ≥6=75% | <6=50%",
      cooldowns_active: cooldowns.length > 0 ? cooldowns : "none",
      smart_reentry:    `5-min stop-loss cooldown per symbol (${COOLDOWN_MS/60000} min)`
    },
    entryModes: {
      trend_following:  `LONG if 1m-MA20>SMA200 + 5m-close≥5m-MA20 | SHORT if 1m-MA20<SMA200 + 5m-close≤5m-MA20`,
      counter_reversal: `LONG/SHORT counter-trend if vol≥${REVERSAL_VOL_MULT}x prior avg (MTF skipped for reversals)`,
      reversal_size:    `${REVERSAL_SIZE_MULT * 100}% (fixed)`,
      reversal_stop:    `-${REVERSAL_STOP_PCT * 100}% vs trend -${STOP_LOSS_PCT * 100}%`
    },
    riskManagement: {
      stopLoss_trend:    `-${STOP_LOSS_PCT * 100}%`,
      stopLoss_reversal: `-${REVERSAL_STOP_PCT * 100}%`,
      takeProfit:        `+${TAKE_PROFIT_PCT * 100}% (swing target)`,
      trailActivate:     `+${TRAIL_ON_PCT * 100}%`,
      trailDistance:     `${TRAIL_DIST_PCT * 100}% from peak`,
      circuitBreaker:    paused || "inactive"
    },
    performance: {
      scanConcurrency:   `${CANDLE_CONCURRENCY} workers (1m) + ${CANDLE_CONCURRENCY_HTF} workers (5m MTF) — parallel`,
      entryLatency:      `~4-5s fetch (1m+5m parallel) + signal check`,
      exitLatency:       "pass1: instant (position data) | pass2: parallel MA20 fetch",
      slotFill:          "immediate — 1.5s after any exit"
    },
    config: {
      timeframe:    `${TIMEFRAME} (entries) + ${TIMEFRAME_HTF} (MTF bias)`,
      leverage:     `${LEVERAGE}x`,
      riskPct:      `${RISK_PCT*100}%`,
      maxMargin:    `$${MAX_MARGIN}`,
      maxMaDist:    `${MAX_MA_DIST_PCT*100}%`,
      watchlist:    WATCHLIST.length,
      blacklist:    BLACKLIST.size,
      scan:         `${SCAN_MS/1000}s`,
      exit:         `${EXIT_POLL_MS/1000}s`,
      cooldown:     `${COOLDOWN_MS/60000}min after stop-loss`
    }
  }, null, 2));
}).listen(PORT, () => log(`🌐 Dashboard → http://localhost:${PORT}`));

// ── Boot ───────────────────────────────────────────────────────────────────────
await syncClock();
log(`🏦 ${RULES.strategy_name} v${RULES.version} — HEDGE FUND EDITION`);
log(`   Target       : $${DAILY_TARGET}/day | $${RULES.targets?.yearly_profit_usdt?.toLocaleString()}/year`);
log(`   Timeframe    : ${TIMEFRAME} entries | ${TIMEFRAME_HTF} MTF bias | MA${MA_PERIOD} | SMA${SMA_PERIOD} | RSI${RSI_PERIOD}`);
log(`   ── TREND ENTRY    within ${MAX_MA_DIST_PCT*100}% MA20 | 2-candle window | 5m MTF confirm | scored size`);
log(`   ── REVERSAL ENTRY vol ≥ ${REVERSAL_VOL_MULT}× prior avg | 50% size | stop -${REVERSAL_STOP_PCT*100}% | no MTF needed`);
log(`   Stop-loss    : -${STOP_LOSS_PCT*100}% trend / -${REVERSAL_STOP_PCT*100}% reversal`);
log(`   Take-profit  : +${TAKE_PROFIT_PCT*100}%  |  Trail: +${TRAIL_ON_PCT*100}% activates, -${TRAIL_DIST_PCT*100}% below peak`);
log(`   AI: Cooldown : ${COOLDOWN_MS/60000}-min re-entry block per symbol after stop-loss`);
log(`   AI: Scoring  : dist+body+trend+MTF+RSI-zone = max 10pts → 50/75/100% size`);
log(`   Circuit brk  : WR < ${WR_MIN*100}% (min ${WR_MIN_TRADES} trades) → pause ${WR_PAUSE_MS/60000}min`);
log(`   Watchlist    : ${WATCHLIST.length} symbols | ${BLACKLIST.size} blacklisted`);
log(`   Scan speed   : ${CANDLE_CONCURRENCY} workers(1m) + ${CANDLE_CONCURRENCY_HTF} workers(5m) in parallel | ~5s total`);
log(`   Exit speed   : pass1 instant | pass2 parallel MA20 | slot-fill 1.5s post-exit`);

await scanEntry("boot");
setInterval(scanEntry, SCAN_MS);
setInterval(pollExits, EXIT_POLL_MS);
