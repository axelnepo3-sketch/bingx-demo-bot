/**
 * BingX Demo Trading Bot — MA Swing Trader v4.3 (Hedge Fund AI Edition)
 * Target: $200/day | $50,000/year
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  HEDGE FUND AI AGENT BEHAVIORS
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. Auto-watchlist     : Top 100 BingX USDT-perp by 24h volume, fetched on
 *                          boot and refreshed every midnight UTC
 *  2. Market regime      : BTC 5m ATR + MA20 slope → BULL_TREND / BEAR_TREND /
 *                          RANGING / VOLATILE — updated every 5 min
 *  3. Regime sizing      : VOLATILE=50% · RANGING=75% · against-trend=75% · with-trend=100%
 *  4. Correlation cap    : Major coins (BTC/ETH/SOL/BNB/…) max 5 positions
 *  5. Portfolio heat     : Total margin exposure % logged on every scan
 *  6. MTF bias           : 5m MA20 must confirm 1m entry (trend entries only)
 *  7. Signal scoring     : max 10pts (distance+body+trend+MTF+RSI-zone) → size
 *  8. Smart cooldown     : 5-min re-entry block per symbol after stop-loss
 *  9. Slot-fill scan     : Immediate re-scan 1.5s after any exit frees a slot
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTRY MODES
 * ═══════════════════════════════════════════════════════════════════════════
 *  A) TREND-FOLLOWING (primary)
 *     LONG : 1m MA20>SMA30 + 5m close≥5m-MA20 + GREEN candle + prev RED
 *            + close≥MA20 ±0.5% + RSI<30 (oversold)
 *     SHORT: 1m MA20<SMA30 + 5m close≤5m-MA20 + RED candle + prev GREEN
 *            + close≤MA20 ±0.5% + RSI>70 (overbought)
 *
 *  B) COUNTER-TREND REVERSAL (vol ≥ 1× prior avg)
 *     LONG : MA20<SMA30 + same candle pattern + vol≥avg → reversal BUY
 *     SHORT: MA20>SMA30 + same candle pattern + vol≥avg → reversal SELL
 *     MTF  : skipped (counter-trend by design)
 *     Size : 50% × regime multiplier
 *     Stop : -2% (unified with trend)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  EXITS (v4.1)
 * ═══════════════════════════════════════════════════════════════════════════
 *  1. Exchange STOP_MARKET order placed on BingX immediately after entry
 *     → real-time stop, no polling delay, exact price execution
 *  2. Trailing-stop (software): activates +2%, trails 2% below peak
 *     → trail fires → cancel exchange stop → market close
 *  3. Software stop fallback: -2% PnL via polling (backup if stop order fails)
 *  Stop: -2%  |  Trail: activates +2%, distance 2%  |  No fixed take-profit
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  CHANGELOG
 * ═══════════════════════════════════════════════════════════════════════════
 *  v4.3: RSI entry filter changed — LONG requires RSI<30 (oversold), SHORT
 *        requires RSI>70 (overbought). Trades only at extremes, not midrange.
 *  v4.2: Bug fixes — cleanup loop iterates peakPnl+stopOrders (was peakPnl
 *        only, missed exchange stops fired before first poll). Symbol extract
 *        uses regex. EXIT_POLL_MS fallback 5000→2000. Stop comment -3%→-2%.
 *        perf.losses tracked for exchange-stopped positions (circuit breaker).
 *  v4.1: Exchange-side STOP_MARKET orders at entry — eliminates polling delay
 *        for stop-loss. cancelExchangeStop before trail exits. Stale-state
 *        cleanup in pollExits detects externally closed positions. Poll 5s→2s.
 *  v4.0: Fixed TP removed. Trail activates +2% (was +4%). Stop -3%→-2% all.
 *  v3.9: MA20 crossover exit removed. pollExits 2-pass→single-pass.
 *  v3.8: SMA200→SMA30 trend indicator. Candle fetch 204→34 bars.
 *  v3.7: HF AI Edition — auto-watchlist 100 symbols, market regime detection,
 *        regime-based sizing, major coin correlation cap, portfolio heat log,
 *        10 scan workers (was 5), ATR calculation, high/low in candles
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

// ── Static Config ──────────────────────────────────────────────────────────────
const BASE_URL        = "https://open-api-vst.bingx.com";
const TIMEFRAME       = RULES.timeframe;                  // "1m"
const TIMEFRAME_HTF   = "5m";                             // MTF bias
const MA_PERIOD       = RULES.indicators.MA20.length;     // 20
const SMA_PERIOD      = RULES.indicators.SMA30.length;   //  30
const HTF_MA_PERIOD   = 20;
const HTF_LIMIT       = 25;
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
const EXIT_POLL_MS    = RULES.limits.exit_poll_ms        || 2000;
const MIN_BODY_PCT    = 0.0002;
const MAX_MA_DIST_PCT = RULES.entry?.max_ma_distance_pct || 0.005;

// Watchlist
const MAX_WATCHLIST        = 100;
const MIN_24H_VOL_USDT     = 1_000_000;   // $1M minimum daily volume

// Concurrency
const CANDLE_CONCURRENCY     = 10;   // 1m parallel workers
const CANDLE_CONCURRENCY_HTF = 5;    // 5m parallel workers

// ── Risk Management ────────────────────────────────────────────────────────────
const rm              = RULES.risk_management || {};
const STOP_LOSS_PCT   = rm.stop_loss_pct           || 0.02;  // -2% hard stop (all positions)
const TRAIL_ON_PCT    = rm.trail_activate_pct      || 0.02;  // trail activates at +2%
const TRAIL_DIST_PCT  = rm.trail_distance_pct      || 0.02;  // trail sits 2% below peak
const DAILY_TARGET    = rm.daily_profit_target_usdt || 200;
const WR_MIN          = rm.win_rate_min             || 0.40;
const WR_MIN_TRADES   = rm.win_rate_min_trades      || 10;
const WR_PAUSE_MS     = (rm.win_rate_pause_minutes  || 30)  * 60_000;
const COOLDOWN_MS     = (rm.stop_cooldown_minutes   || 5)   * 60_000;

// ── Reversal Config ────────────────────────────────────────────────────────────
const rev = RULES.reversal_entry || {};
const REVERSAL_VOL_MULT  = rev.volume_multiplier ?? 1.0;   // 1× = vol ≥ avg
const REVERSAL_STOP_PCT  = rev.stop_loss_pct     || 0.02;  // unified -2%
const REVERSAL_SIZE_MULT = rev.size_multiplier   || 0.50;  // 50% base size

// ── Hedge Fund: Correlation Control ───────────────────────────────────────────
// Major coins are highly correlated with BTC — cap simultaneous exposure
const MAJOR_COINS = new Set([
  "BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT", "AVAX-USDT",
  "ADA-USDT", "XRP-USDT", "NEAR-USDT", "TRX-USDT", "BCH-USDT",
  "LTC-USDT", "DOGE-USDT", "DOT-USDT", "LINK-USDT", "MATIC-USDT",
  "INJ-USDT", "APT-USDT", "ARB-USDT", "OP-USDT",   "ATOM-USDT",
  "FIL-USDT", "ICP-USDT", "HBAR-USDT","SUI-USDT",  "WLD-USDT"
]);
const MAX_MAJOR_POSITIONS = RULES.hf_agent?.max_major_positions || 5;

const BLACKLIST = new Set(RULES.blacklist || []);
let   WATCHLIST = (RULES.watchlist || []).filter(s => !BLACKLIST.has(s));  // replaced on boot
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
  const r  = await axios.get(`${BASE_URL}${path}?${qs}`, { headers: { "X-BX-APIKEY": k }, timeout: 8000 });
  return r.data;
}
async function POST(path, params = {}) {
  const { k, s } = creds();
  const qs = buildQS({ ...params, timestamp: bingxNow() }, s);
  const r  = await axios.post(`${BASE_URL}${path}?${qs}`, null, { headers: { "X-BX-APIKEY": k }, timeout: 8000 });
  return r.data;
}
async function DEL(path, params = {}) {
  const { k, s } = creds();
  const qs = buildQS({ ...params, timestamp: bingxNow() }, s);
  const r  = await axios.delete(`${BASE_URL}${path}?${qs}`, { headers: { "X-BX-APIKEY": k }, timeout: 8000 });
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
const peakPnl           = new Map();   // peak PnL per position
const closingPositions  = new Set();   // in-flight closes
const reversalPositions = new Set();   // counter-trend positions (for log tagging)
const stopCooldowns     = new Map();   // symbol → cooldown end timestamp
const stopOrders        = new Map();   // `${sym}-${side}` → BingX stop orderId
let   winRatePauseUntil = 0;
let   fillScanTimer     = null;

// ── HF: Market Regime ─────────────────────────────────────────────────────────
let marketRegime    = "UNKNOWN";   // BULL_TREND | BEAR_TREND | RANGING | VOLATILE
let regimeUpdatedAt = 0;

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
    stopOrders.clear();
    log(`📅 Daily reset — all counters cleared`);
    // Refresh watchlist and regime on new day (non-blocking)
    refreshWatchlist().catch(e => log(`WARN: midnight watchlist refresh failed: ${e.message}`));
    updateMarketRegime().catch(e => log(`WARN: midnight regime update failed: ${e.message}`));
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

// ATR (Average True Range) — requires high/low in candles
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  let trSum = 0;
  for (let i = 1; i < recent.length; i++) {
    const h   = recent[i].high  ?? recent[i].close;
    const l   = recent[i].low   ?? recent[i].close;
    const pc  = recent[i - 1].close;
    trSum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return trSum / period;
}

// volAvg excludes forming bar AND curr bar to prevent self-inflation of baseline
function volAvg(candles, period = VOL_PERIOD) {
  const prior = candles.slice(0, -2);
  if (prior.length < period) return null;
  const vols = prior.slice(-period).map(c => c.volume || 0);
  return vols.reduce((a, b) => a + b, 0) / period;
}

// ── Signal quality score (max 10) ─────────────────────────────────────────────
function signalScore(distPct, bodyPct, ma20, sma30, rsiVal, mtfConfirmed) {
  let s = 0;
  if      (distPct < 0.001) s += 3; else if (distPct < 0.003) s += 2; else s += 1;
  if      (bodyPct > 0.002) s += 3; else if (bodyPct > 0.001) s += 2; else s += 1;
  const trendGap = sma30 > 0 ? Math.abs(ma20 - sma30) / sma30 : 0;
  if (trendGap > 0.002) s += 2; else s += 1;  // 0.2% threshold fits MA20/SMA30 proximity
  if (mtfConfirmed) s += 1;
  if (rsiVal && rsiVal >= 40 && rsiVal <= 60) s += 1;
  return s;
}

function sizeMultiplier(score) {
  if (score >= 8) return 1.00;
  if (score >= 6) return 0.75;
  return 0.50;
}

// ── HF: Regime size multiplier ────────────────────────────────────────────────
// Regime adjusts position size on top of signal score multiplier
// VOLATILE    → 50% (MA bounces unreliable in high chop)
// RANGING     → 75% (low conviction, sideways market)
// BULL_TREND  → 100% LONG / 75% SHORT (favor the trend)
// BEAR_TREND  → 100% SHORT / 75% LONG (favor the trend)
// UNKNOWN     → 100% (no penalty for detection failure)
function regimeSizeMultiplier(signal) {
  switch (marketRegime) {
    case "VOLATILE":   return 0.50;
    case "RANGING":    return 0.75;
    case "BULL_TREND": return signal === "LONG"  ? 1.00 : 0.75;
    case "BEAR_TREND": return signal === "SHORT" ? 1.00 : 0.75;
    default:           return 1.00;
  }
}

// ── Entry signal ───────────────────────────────────────────────────────────────
function checkEntry(candles1m, candles5m = null) {
  if (candles1m.length < SMA_PERIOD + 3) return null;

  const curr = candles1m[candles1m.length - 2];
  const prev = candles1m[candles1m.length - 3];

  const candleTime = curr.time < 1_000_000_000_000 ? curr.time * 1000 : curr.time;
  const signalAge  = bingxNow() - (candleTime + CANDLE_MS);
  if (signalAge < 0)              return null;
  if (signalAge >= CANDLE_MS * 2) return null;

  const cc     = candles1m.slice(0, -1).map(c => c.close);
  const ma20   = sma(cc, MA_PERIOD);
  const sma30 = sma(cc, SMA_PERIOD);
  const rsiVal = rsi(cc);
  if (!ma20 || !sma30) return null;

  const bullish = ma20 > sma30;
  const bearish = ma20 < sma30;
  if (!bullish && !bearish) return null;

  const bodyPct = Math.abs(curr.close - curr.open) / curr.open;
  if (bodyPct < MIN_BODY_PCT) return null;

  const distPct = Math.abs(curr.close - ma20) / ma20;
  if (distPct > MAX_MA_DIST_PCT) return null;

  const currGreen = curr.close > curr.open;
  const currRed   = curr.close < curr.open;
  const prevRed   = prev.close < prev.open;
  const prevGreen = prev.close > prev.open;
  const rsiOK_long  = !rsiVal || rsiVal < 30;   // oversold → LONG
  const rsiOK_short = !rsiVal || rsiVal > 70;   // overbought → SHORT

  const avgVol   = volAvg(candles1m);
  const currVol  = curr.volume || 0;
  const volRatio = avgVol && currVol > 0 ? currVol / avgVol : null;

  let signal     = null;
  let isReversal = false;

  // MODE A: trend-following
  if (bullish && currGreen && prevRed   && curr.close >= ma20 && rsiOK_long)  signal = "LONG";
  if (bearish && currRed   && prevGreen && curr.close <= ma20 && rsiOK_short) signal = "SHORT";

  // MODE B: counter-trend reversal (vol ≥ 1× prior avg)
  if (!signal && avgVol && currVol >= avgVol * REVERSAL_VOL_MULT) {
    if (bearish && currGreen && prevRed   && curr.close >= ma20 && rsiOK_long)  { signal = "LONG";  isReversal = true; }
    if (bullish && currRed   && prevGreen && curr.close <= ma20 && rsiOK_short) { signal = "SHORT"; isReversal = true; }
  }

  if (!signal) return null;

  // MTF filter: 5m MA20 must align with signal (trend entries only)
  let mtfConfirmed = false;
  let mtfTag       = "n/a";

  if (!isReversal && candles5m && candles5m.length >= HTF_MA_PERIOD + 2) {
    const cc5m   = candles5m.slice(0, -1).map(c => c.close);
    const ma5m   = sma(cc5m, HTF_MA_PERIOD);
    const last5m = cc5m[cc5m.length - 1];
    if (ma5m) {
      if (signal === "LONG"  && last5m < ma5m) return null;
      if (signal === "SHORT" && last5m > ma5m) return null;
      mtfConfirmed = true;
      mtfTag       = "✅5m";
    }
  } else if (!isReversal) {
    mtfTag = "⚡no5m";
  }

  const score = signalScore(distPct, bodyPct, ma20, sma30, rsiVal, mtfConfirmed);
  return { signal, score, distPct, bodyPct, rsi: rsiVal, ma20, sma30, isReversal, volRatio, mtfConfirmed, mtfTag };
}

// checkExit (MA20-crossover) removed in v3.9 — exits are stop-loss / take-profit / trailing-stop only

// ── Market data ────────────────────────────────────────────────────────────────
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
          high:   parseFloat(c.high   || c.close),
          low:    parseFloat(c.low    || c.close),
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

// Parallel candle fetcher — concurrency auto-selects by timeframe
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

// ── HF: Auto-Watchlist ─────────────────────────────────────────────────────────
// Fetch top N USDT perpetual futures by 24h USD volume from BingX
async function fetchTopSymbols(n = MAX_WATCHLIST) {
  try {
    const d = await GET("/openApi/swap/v2/quote/ticker");
    const tickers = Array.isArray(d?.data) ? d.data : [];
    const filtered = tickers
      .filter(t => t.symbol && t.symbol.endsWith("-USDT") && !BLACKLIST.has(t.symbol))
      .filter(t => parseFloat(t.quoteVolume || t.volume24H || t.volume || 0) >= MIN_24H_VOL_USDT)
      .sort((a, b) =>
        parseFloat(b.quoteVolume || b.volume24H || b.volume || 0) -
        parseFloat(a.quoteVolume || a.volume24H || a.volume || 0)
      )
      .slice(0, n)
      .map(t => t.symbol);

    if (filtered.length < 10) throw new Error(`only ${filtered.length} symbols returned — API may differ`);
    return filtered;
  } catch (e) {
    log(`WARN: auto-watchlist fetch failed (${e.message}) — using rules.json fallback`);
    return (RULES.watchlist || []).filter(s => !BLACKLIST.has(s));
  }
}

async function refreshWatchlist() {
  const oldList = [...WATCHLIST];
  const fresh   = await fetchTopSymbols(MAX_WATCHLIST);
  WATCHLIST     = fresh;
  const added   = fresh.filter(s => !oldList.includes(s));
  const removed = oldList.filter(s => !fresh.includes(s));
  log(`📋 Watchlist refreshed: ${WATCHLIST.length} symbols (top ${MAX_WATCHLIST} BingX USDT-perp by 24h vol, min $${(MIN_24H_VOL_USDT/1e6).toFixed(0)}M)`);
  if (added.length   > 0) log(`   ✅ Added   (${added.length}):   ${added.slice(0, 8).join(", ")}${added.length > 8 ? "…" : ""}`);
  if (removed.length > 0) log(`   ❌ Removed (${removed.length}): ${removed.slice(0, 8).join(", ")}${removed.length > 8 ? "…" : ""}`);
}

// ── HF: Market Regime Detection ───────────────────────────────────────────────
// Uses BTC 5m candles (ATR for volatility + MA20 slope for direction)
// ATR > 0.3%/bar → VOLATILE | slope > 0.05% → BULL/BEAR_TREND | else RANGING
async function updateMarketRegime() {
  try {
    const candles = await getCandles("BTC-USDT", "5m", 40);
    if (candles.length < 25) { marketRegime = "UNKNOWN"; return; }

    const closed = candles.slice(0, -1);  // exclude forming bar
    const cc     = closed.map(c => c.close);

    // Volatility: ATR relative to price
    const atrVal  = atr(closed, 14);
    const btcPx   = cc[cc.length - 1];
    const atrPct  = atrVal && btcPx ? atrVal / btcPx : 0;

    // Trend: MA20 slope over last 5 closed bars
    const maNow   = sma(cc, 20);
    const ma5ago  = sma(cc.slice(0, -5), 20);
    const slope   = maNow && ma5ago ? (maNow - ma5ago) / ma5ago : 0;

    const prev = marketRegime;

    if (atrPct > 0.003) {
      marketRegime = "VOLATILE";
    } else if (Math.abs(slope) > 0.0005) {
      marketRegime = slope > 0 ? "BULL_TREND" : "BEAR_TREND";
    } else {
      marketRegime = "RANGING";
    }

    regimeUpdatedAt = Date.now();

    if (prev !== marketRegime) {
      const regimeEmoji = { BULL_TREND: "🟢", BEAR_TREND: "🔴", RANGING: "🟡", VOLATILE: "⚡" };
      log(`${regimeEmoji[marketRegime] || "⚪"} Regime → ${marketRegime} | BTC ATR:${(atrPct*100).toFixed(3)}%/bar | MA slope:${(slope*100).toFixed(3)}%`);
    }
  } catch (e) {
    log(`WARN: regime detection failed — ${e.message}`);
    marketRegime = "UNKNOWN";
  }
}

// ── Position sizing ────────────────────────────────────────────────────────────
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

// ── Exchange-side stop order helpers ──────────────────────────────────────────
function roundStopPrice(p) {
  if      (p >= 10000) return Math.round(p * 1)    / 1;
  else if (p >=  1000) return Math.round(p * 10)   / 10;
  else if (p >=   100) return Math.round(p * 100)  / 100;
  else if (p >=    10) return Math.round(p * 1000) / 1000;
  else if (p >=     1) return Math.round(p * 10000)/ 10000;
  else                 return Math.round(p * 100000)/100000;
}

async function placeExchangeStop(symbol, positionSide, qty, entryPrice) {
  // Price move that equals STOP_LOSS_PCT PnL at current leverage
  const isRev    = reversalPositions.has(`${symbol}-${positionSide}`);
  const stopPct  = isRev ? REVERSAL_STOP_PCT : STOP_LOSS_PCT;
  const priceMov = stopPct / LEVERAGE;
  const rawStop  = positionSide === "LONG"
    ? entryPrice * (1 - priceMov)
    : entryPrice * (1 + priceMov);
  const sp       = roundStopPrice(rawStop);
  const side     = positionSide === "LONG" ? "SELL" : "BUY";
  try {
    const r = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide,
      type:      "STOP_MARKET",
      quantity:  Math.abs(qty),
      stopPrice: sp
    });
    if (r?.code === 0) {
      const orderId = r.data?.order?.orderId;
      if (orderId) stopOrders.set(`${symbol}-${positionSide}`, orderId);
      log(`🔒 STOP-ORDER  ${positionSide.padEnd(5)} ${symbol.padEnd(18)} @${sp} (≈-${(stopPct*100).toFixed(0)}%PnL)`);
    } else {
      log(`⚠️  STOP-ORDER FAIL ${symbol} ${positionSide} code=${r?.code} — software fallback active`);
    }
  } catch (e) {
    log(`⚠️  STOP-ORDER ERR ${symbol}: ${e.message} — software fallback active`);
  }
}

async function cancelExchangeStop(symbol, positionSide) {
  const posKey  = `${symbol}-${positionSide}`;
  const orderId = stopOrders.get(posKey);
  if (!orderId) return;
  stopOrders.delete(posKey);
  try {
    await DEL("/openApi/swap/v2/trade/order", { symbol, orderId });
    log(`🗑  STOP-ORDER CANCELLED ${positionSide} ${symbol}`);
  } catch (e) {
    // May already be filled — not an error
    log(`ℹ️  STOP-ORDER CANCEL ${symbol} ${positionSide} — ${e.message}`);
  }
}

// ── Place entry ────────────────────────────────────────────────────────────────
async function placeEntry(symbol, signal, score, bal, isReversal = false, regimeAdj = 1.0) {
  try {
    const price = await getLivePrice(symbol);
    if (!price) { log(`SKIP ${symbol} — no live price`); return false; }

    const scoreMult  = isReversal ? REVERSAL_SIZE_MULT : sizeMultiplier(score);
    const finalMult  = Math.max(0.10, scoreMult * regimeAdj);   // floor at 10%
    const qty        = calcQty(bal, price, finalMult);
    const notional   = qty * price;
    if (qty <= 0 || notional < MIN_NOTIONAL) {
      log(`SKIP ${symbol} qty=${qty} notional=${notional.toFixed(2)} < min`);
      return false;
    }

    const side         = signal === "LONG" ? "BUY" : "SELL";
    const positionSide = signal;
    const modeTag      = isReversal ? " ⚡REV" : "";
    const regimeTag    = regimeAdj < 1.0 ? ` [regime:${(regimeAdj*100).toFixed(0)}%]` : "";

    try { await POST("/openApi/swap/v2/trade/leverage", { symbol, side: signal, leverage: LEVERAGE }); } catch {}

    const r = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: qty
    });

    if (r?.code === 0) {
      stats.trades++;
      tradeToday++;
      if (isReversal) reversalPositions.add(`${symbol}-${signal}`);
      log(`✅ SWING${modeTag} ${signal.padEnd(5)} ${symbol.padEnd(18)} qty=${qty} @~${price} ${LEVERAGE}x | score=${score}/10(${(finalMult*100).toFixed(0)}%)${regimeTag} trail≥+${TRAIL_ON_PCT*100}%/−${TRAIL_DIST_PCT*100}% stop=-${STOP_LOSS_PCT*100}% | today=${tradeToday}`);
      // Place exchange-side STOP_MARKET immediately — no polling delay
      await placeExchangeStop(symbol, signal, qty, price);
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
    // Cancel exchange stop order first — prevents double-close race
    await cancelExchangeStop(symbol, positionSide);
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
function scheduleFillScan() {
  if (fillScanTimer) clearTimeout(fillScanTimer);
  fillScanTimer = setTimeout(() => {
    fillScanTimer = null;
    scanEntry("slot-fill");
  }, 1500);
}

// ── Entry scan ─────────────────────────────────────────────────────────────────
// Stage 1 : parallel fetch — 1m (10 workers) + 5m (5 workers) simultaneously
// Stage 2 : evaluate signals with regime, correlation, cooldown checks
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

    // HF: portfolio heat
    const portfolioMargin = positions.reduce((sum, p) => {
      const qty   = Math.abs(parseFloat(p.positionAmt  || 0));
      const price = parseFloat(p.avgPrice || p.entryPrice || 0);
      return sum + (qty * price > 0 ? qty * price / LEVERAGE : 0);
    }, 0);
    const heatPct = (bal + portfolioMargin) > 0
      ? (portfolioMargin / (bal + portfolioMargin) * 100).toFixed(1)
      : "0.0";

    // HF: correlation — count current major coin positions
    let majorCount = positions.filter(p => MAJOR_COINS.has(p.symbol)).length;

    const openCount0 = positions.length;
    const slots      = MAX_OPEN - openCount0;
    let   openCount  = openCount0;
    let   signals    = 0;
    let   blocked    = 0;
    const total      = perf.wins + perf.losses;
    const wr         = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "n/a";
    const scanTag    = reason === "slot-fill" ? "🔄 SLOT-FILL" : (reason === "boot" ? "🚀 BOOT-SCAN" : "═ SCAN");
    const regimeAge  = regimeUpdatedAt > 0 ? `${Math.round((Date.now() - regimeUpdatedAt) / 60000)}m ago` : "pending";

    log(`${scanTag} [${slots} slot${slots !== 1 ? "s" : ""} free] | regime=${marketRegime}(${regimeAge}) | heat=${heatPct}% | bal=$${bal.toFixed(2)} | open=${openCount}/${MAX_OPEN} | checking=${toCheck.length} | today=${tradeToday} | PnL:$${perf.dailyPnl.toFixed(2)}/$${DAILY_TARGET} | WR:${wr}`);

    // Stage 1: fetch 1m + 5m in parallel
    const scanStart = Date.now();
    const [candleMap1m, candleMap5m] = await Promise.all([
      fetchCandlesBatch(toCheck, TIMEFRAME,     SMA_PERIOD + 4),
      fetchCandlesBatch(toCheck, TIMEFRAME_HTF, HTF_LIMIT)
    ]);
    const fetchMs = Date.now() - scanStart;

    // Stage 2: evaluate and place
    for (const sym of toCheck) {
      if (tradeToday >= MAX_DAILY) break;
      if (openCount  >= MAX_OPEN)  break;
      if (busy.has(sym))           continue;

      const cv1m = candleMap1m.get(sym) || [];
      const cv5m = candleMap5m.get(sym) || [];

      const result = checkEntry(cv1m, cv5m.length >= HTF_MA_PERIOD + 2 ? cv5m : null);
      if (!result) continue;

      signals++;
      const { signal, score, distPct, bodyPct, rsi: rsiVal, isReversal, volRatio, mtfTag } = result;

      // HF: cooldown check (after signal detection — only log when a real signal is blocked)
      if (stopCooldowns.has(sym)) {
        const cdEnd = stopCooldowns.get(sym);
        if (Date.now() < cdEnd) {
          blocked++;
          const remaining = Math.ceil((cdEnd - Date.now()) / 1000);
          log(`⏸  COOLDOWN   ${sym.padEnd(18)} signal=${signal} blocked — ${remaining}s remaining`);
          continue;
        }
        stopCooldowns.delete(sym);
      }

      // HF: correlation cap — skip if too many major coins already open
      if (MAJOR_COINS.has(sym) && majorCount >= MAX_MAJOR_POSITIONS) {
        blocked++;
        log(`🔗 CORR-CAP   ${sym.padEnd(18)} signal=${signal} blocked — ${majorCount}/${MAX_MAJOR_POSITIONS} major positions open`);
        continue;
      }

      // HF: regime-based size adjustment
      const regimeAdj = regimeSizeMultiplier(signal);

      const lastBar  = cv1m[cv1m.length - 2];
      const age      = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      const rsiStr   = rsiVal  ? rsiVal.toFixed(1)    : "n/a";
      const volStr   = volRatio ? `${volRatio.toFixed(1)}x` : "n/a";
      const revLabel = isReversal ? " ⚡REVERSAL" : "";
      const regLabel = regimeAdj < 1.0 ? ` regime:${(regimeAdj*100).toFixed(0)}%` : "";

      log(`📊 SIGNAL${revLabel} ${signal.padEnd(5)} ${sym.padEnd(18)} score:${score}/10 | dist:${(distPct*100).toFixed(3)}% | body:${(bodyPct*100).toFixed(3)}% | RSI:${rsiStr} | vol:${volStr} | MTF:${mtfTag}${regLabel} | age:${age}s`);

      const placed = await placeEntry(sym, signal, score, bal, isReversal, regimeAdj);
      if (placed) {
        openCount++;
        busy.add(sym);
        if (MAJOR_COINS.has(sym)) majorCount++;
        bal = await getBalance();
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
      }
    }

    if (signals > 0 || reason !== "interval") {
      log(`═ SCAN DONE | fetch:${fetchMs}ms(1m+5m‖) | signals=${signals} blocked=${blocked} | trades_today=${tradeToday} | PnL:$${perf.dailyPnl.toFixed(2)}`);
    }
  } catch (e) {
    stats.errors++;
    log(`SCAN CRASH: ${e.message}`);
  } finally {
    scanning = false;
  }
}

// ── Exit monitor ──────────────────────────────────────────────────────────────
// Priority: 1=exchange STOP_MARKET (BingX real-time) | 2=trail (polling, 2s)
//           3=software stop fallback (backup if stop order failed to place)
let polling = false;
async function pollExits() {
  if (polling) return;
  polling = true;
  let exitsFired = 0;
  try {
    checkDailyReset();

    const positions = await getOpenPositions();

    // ── Stale-state cleanup: detect positions BingX closed via exchange stop ─
    // Iterates BOTH peakPnl and stopOrders — catches positions where exchange
    // stop fired before the first poll cycle (peakPnl not yet set for them).
    const activePosKeys = new Set(
      positions
        .filter(p => parseFloat(p.positionAmt || 0) !== 0)
        .map(p => `${p.symbol}-${p.positionSide}`)
    );
    const trackedKeys = new Set([...peakPnl.keys(), ...stopOrders.keys()]);
    for (const key of trackedKeys) {
      if (!activePosKeys.has(key)) {
        const hadStopOrder = stopOrders.has(key);
        peakPnl.delete(key);
        closingPositions.delete(key);
        reversalPositions.delete(key);
        stopOrders.delete(key);
        if (hadStopOrder) {
          // Exchange stop fired — record as loss, set cooldown, free slot
          const sym = key.replace(/-(?:LONG|SHORT)$/, "");
          perf.losses++;
          perf.dailyPnl -= (STOP_LOSS_PCT * 100);  // rough estimate ($)
          log(`🔒→❌ EXCHANGE STOP FILLED ${key} — loss recorded | W/L:${perf.wins}/${perf.losses}`);
          exitsFired++;
          stopCooldowns.set(sym, Date.now() + COOLDOWN_MS);
          log(`⏸  COOLDOWN SET ${sym} — ${COOLDOWN_MS/60000}min after exchange stop`);
        }
      }
    }

    if (!positions.length) return;

    for (const pos of positions) {
      const sym   = pos.symbol;
      const side  = pos.positionSide;
      const qty   = parseFloat(pos.positionAmt || 0);
      const entry = parseFloat(pos.avgPrice    || pos.entryPrice || 0);

      if (!qty || !["LONG", "SHORT"].includes(side) || !entry) continue;

      const posKey = `${sym}-${side}`;
      if (closingPositions.has(posKey)) continue;

      const isRev   = reversalPositions.has(posKey);
      const stopPct = isRev ? REVERSAL_STOP_PCT : STOP_LOSS_PCT;
      const revTag  = isRev ? " ⚡REV" : "";

      // ── Method A: BingX unrealized PnL fields (no extra API call) ────────
      let pnlPct = null, pnlUsd = null, cachedLp = 0;
      const bxPnl    = parseFloat(pos.unrealizedProfit ?? "NaN");
      const bxMargin = parseFloat(pos.initialMargin    ?? pos.margin ?? "NaN");

      if (isFinite(bxPnl) && isFinite(bxMargin) && bxMargin > 0) {
        pnlPct = bxPnl / bxMargin;
        pnlUsd = bxPnl;
      } else {
        // ── Method B fallback: live price delta ─────────────────────────────
        cachedLp = await getLivePrice(sym);
        if (!cachedLp) continue;
        const pp   = side === "LONG" ? (cachedLp - entry)/entry : (entry - cachedLp)/entry;
        const margin = Math.min(Math.abs(qty) * entry / LEVERAGE, MAX_MARGIN);
        pnlPct = pp * LEVERAGE;
        pnlUsd = pp * margin * LEVERAGE;
      }

      // ── Update trailing-stop peak ─────────────────────────────────────────
      const prevPeak = peakPnl.get(posKey) ?? -Infinity;
      if (pnlPct > prevPeak) peakPnl.set(posKey, pnlPct);
      const peak = peakPnl.get(posKey);

      // ── 1. Software stop fallback (exchange stop is primary) ─────────────
      if (pnlPct <= -stopPct) {
        const lp = cachedLp || await getLivePrice(sym);
        log(`🛑 STOP-LOSS${revTag} [sw-fallback] ${side.padEnd(5)} ${sym.padEnd(18)} PnL:${(pnlPct*100).toFixed(2)}% $${pnlUsd.toFixed(2)} stop=${stopPct*100}%`);
        closingPositions.add(posKey);
        const ok = await placeExit(sym, side, qty, entry, `stop-loss${isRev?"-rev":""}`, lp);
        if (ok) {
          exitsFired++;
          stopCooldowns.set(sym, Date.now() + COOLDOWN_MS);
          log(`⏸  COOLDOWN SET ${sym} — ${COOLDOWN_MS/60000}min block after stop-loss`);
        }
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));

      // ── 2. Trailing-stop ──────────────────────────────────────────────────
      } else if (peak >= TRAIL_ON_PCT && pnlPct <= peak - TRAIL_DIST_PCT) {
        const lp = cachedLp || await getLivePrice(sym);
        log(`📉 TRAIL-STOP${revTag}  ${side.padEnd(5)} ${sym.padEnd(18)} peak:${(peak*100).toFixed(2)}% now:${(pnlPct*100).toFixed(2)}%`);
        closingPositions.add(posKey);
        const ok = await placeExit(sym, side, qty, entry, `trail-stop${isRev?"-rev":""}`, lp);
        if (ok) exitsFired++;
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
      }
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

  const total     = perf.wins + perf.losses;
  const winRatio  = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "0%";
  const paused    = winRatePauseUntil > Date.now()
    ? `circuit breaker — resumes in ${Math.ceil((winRatePauseUntil - Date.now()) / 60000)}min`
    : null;
  const cooldowns = [...stopCooldowns.entries()]
    .filter(([, end]) => Date.now() < end)
    .map(([sym, end]) => `${sym}:${Math.ceil((end - Date.now()) / 1000)}s`);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status:    paused ? `⚠️ ${paused}` : "🟢 running 24/7",
    strategy:  `${RULES.strategy_name} v${RULES.version} | MA${MA_PERIOD}/SMA${SMA_PERIOD}/RSI${RSI_PERIOD} | ${TIMEFRAME}+${TIMEFRAME_HTF}MTF`,
    uptime:    Math.round(process.uptime()) + "s",
    trades:    stats.trades,
    today:     `${tradeToday}/${MAX_DAILY}`,
    errors:    stats.errors,
    lastScan:  stats.lastScan,
    lastExit:  stats.lastExit,
    perf: {
      wins:     perf.wins,
      losses:   perf.losses,
      winRatio,
      dailyPnl: `$${perf.dailyPnl.toFixed(2)} / $${DAILY_TARGET}`,
      progress: `${((perf.dailyPnl / DAILY_TARGET) * 100).toFixed(1)}%`
    },
    hedgeFundAI: {
      market_regime:       `${marketRegime} (updated ${regimeUpdatedAt > 0 ? Math.round((Date.now()-regimeUpdatedAt)/60000)+"m ago" : "pending"})`,
      regime_sizing:       "VOLATILE=50% · RANGING=75% · with-trend=100% · against-trend=75%",
      correlation_cap:     `max ${MAX_MAJOR_POSITIONS} major-coin positions open simultaneously`,
      cooldowns_active:    cooldowns.length > 0 ? cooldowns : "none",
      watchlist_size:      WATCHLIST.length,
      scoring:             "max 10pts: distance(1-3)+body(1-3)+trend-gap(1-2)+MTF(+1)+RSI-zone(+1)"
    },
    entryModes: {
      trend:    `LONG: 1m-MA>SMA30 + 5m-close≥5m-MA20 | SHORT: 1m-MA<SMA30 + 5m-close≤5m-MA20`,
      reversal: `counter-trend vol≥${REVERSAL_VOL_MULT}× avg | 50%×regime size | stop -${REVERSAL_STOP_PCT*100}%`
    },
    riskManagement: {
      stopLoss:       `-${STOP_LOSS_PCT * 100}% (all positions)`,
      trailActivate:  `+${TRAIL_ON_PCT * 100}% (no fixed TP — trail rides winners)`,
      trailDistance:  `${TRAIL_DIST_PCT * 100}% below peak`,
      smartCooldown:  `${COOLDOWN_MS/60000}min per symbol after stop-loss`,
      circuitBreaker: paused || "inactive"
    },
    performance: {
      workers:     `${CANDLE_CONCURRENCY} (1m) + ${CANDLE_CONCURRENCY_HTF} (5m) — parallel`,
      scanTime:    "~8s for 100 symbols",
      slotFill:    "1.5s after any exit"
    },
    config: {
      timeframe:  `${TIMEFRAME}+${TIMEFRAME_HTF}`,
      leverage:   `${LEVERAGE}x`,
      riskPct:    `${RISK_PCT*100}%`,
      maxMargin:  `$${MAX_MARGIN}`,
      watchlist:  WATCHLIST.length,
      blacklist:  BLACKLIST.size,
      scan:       `${SCAN_MS/1000}s`,
      exit:       `${EXIT_POLL_MS/1000}s`
    }
  }, null, 2));
}).listen(PORT, () => log(`🌐 Dashboard → http://localhost:${PORT}`));

// ── Boot ───────────────────────────────────────────────────────────────────────
await syncClock();
log(`🏦 ${RULES.strategy_name} v${RULES.version} — HEDGE FUND AI EDITION`);
log(`   Target       : $${DAILY_TARGET}/day | $${RULES.targets?.yearly_profit_usdt?.toLocaleString()}/year`);
log(`   Timeframe    : ${TIMEFRAME} entries | ${TIMEFRAME_HTF} MTF bias | MA${MA_PERIOD} | SMA${SMA_PERIOD} | RSI${RSI_PERIOD}`);

// HF: load watchlist and regime before first scan
await refreshWatchlist();
await updateMarketRegime();

log(`   Watchlist    : ${WATCHLIST.length} symbols (auto-fetched, top ${MAX_WATCHLIST} by 24h vol)`);
log(`   Regime       : ${marketRegime}`);
log(`   ── TREND ENTRY    within ${MAX_MA_DIST_PCT*100}% MA20 | 2-bar window | 5m MTF | scored 50/75/100%`);
log(`   ── REVERSAL ENTRY vol ≥ ${REVERSAL_VOL_MULT}× avg | 50%×regime | stop -${REVERSAL_STOP_PCT*100}% | no MTF`);
log(`   Stop-loss    : -${STOP_LOSS_PCT*100}% all positions`);
log(`   Trail-stop   : activates +${TRAIL_ON_PCT*100}%, trails ${TRAIL_DIST_PCT*100}% below peak | no fixed take-profit — winners ride`);
log(`   HF: Regime   : VOLATILE=50% · RANGING=75% · with-trend=100% · against-trend=75%`);
log(`   HF: Corr cap : max ${MAX_MAJOR_POSITIONS} major coins simultaneously`);
log(`   HF: Cooldown : ${COOLDOWN_MS/60000}-min block per symbol after stop-loss`);
log(`   Scan workers : ${CANDLE_CONCURRENCY}(1m) + ${CANDLE_CONCURRENCY_HTF}(5m) parallel → ~8s per scan`);
log(`   Slot fill    : 1.5s post-exit | circuit breaker: WR<${WR_MIN*100}% → pause ${WR_PAUSE_MS/60000}min`);

// Regime refresh every 5 minutes
setInterval(updateMarketRegime, 5 * 60 * 1000);

await scanEntry("boot");
setInterval(scanEntry, SCAN_MS);
setInterval(pollExits, EXIT_POLL_MS);
