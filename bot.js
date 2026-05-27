/**
 * BingX Demo Trading Bot — MA20 Scalper v2.1 (Consolidated)
 * Single process: entry scan + exit monitor + stop-loss
 * All parameters driven by rules.json
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
  throw new Error("rules.json not found — cannot start");
}
const RULES = loadRules();

// ── Config (all from rules.json) ───────────────────────────────────────────────
const BASE_URL        = "https://open-api-vst.bingx.com";
const TIMEFRAME       = RULES.timeframe;
const MA_PERIOD       = RULES.indicators.MA20.length;             // 20
const SMA_PERIOD      = RULES.indicators.SMA200.length;           // 200
const LEVERAGE        = RULES.position_sizing.leverage;           // 5
const RISK_PCT        = RULES.position_sizing.risk_pct;           // 0.01
const MAX_MARGIN      = RULES.position_sizing.max_margin;         // 500
const MIN_NOTIONAL    = RULES.position_sizing.min_notional;       // 5
const MAX_OPEN        = RULES.limits.max_open_positions;          // 20
const MAX_DAILY       = RULES.limits.max_trades_per_day;          // 500
const ORDER_DELAY_MS  = RULES.limits.api_delay_ms       || 500;   // after order placement
const FETCH_DELAY_MS  = RULES.limits.fetch_delay_ms     || 200;   // between candle fetches
const SCAN_MS         = RULES.limits.scan_interval_ms   || 5000;
const EXIT_POLL_MS    = RULES.limits.exit_poll_ms        || 5000;
const STOP_LOSS_PCT   = RULES.limits.stop_loss_pct       || 0.03;
const MAX_MA_DIST_PCT = RULES.entry?.max_ma_distance_pct || 0.005;
const MIN_BODY_PCT    = 0.0002;
const BLACKLIST       = new Set(RULES.blacklist || []);
const WATCHLIST       = (RULES.watchlist || []).filter(s => !BLACKLIST.has(s));
const PORT            = process.env.PORT || 3000;

// Candle duration in ms
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

// Re-sync clock every hour to prevent drift over long runs
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
  const r  = await axios.get(`${BASE_URL}${path}?${qs}`, {
    headers: { "X-BX-APIKEY": k },
    timeout: 5000   // FIX: was 10000ms — fail fast, don't stall the scan
  });
  return r.data;
}

async function POST(path, params = {}) {
  const { k, s } = creds();
  const qs = buildQS({ ...params, timestamp: bingxNow() }, s);
  const r  = await axios.post(`${BASE_URL}${path}?${qs}`, null, {
    headers: { "X-BX-APIKEY": k },
    timeout: 5000   // FIX: was 10000ms
  });
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

// ── Daily reset ────────────────────────────────────────────────────────────────
let tradeToday = 0;
let tradeDate  = new Date().toISOString().slice(0, 10);

function checkDailyReset() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== tradeDate) {
    tradeDate     = today;
    tradeToday    = 0;
    perf.dailyPnl = 0;
    log("📅 Daily reset — trade counter and P&L cleared");
  }
}

// ── SMA ────────────────────────────────────────────────────────────────────────
function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Entry signal ───────────────────────────────────────────────────────────────
//
//  LONG:  GREEN candle + prev RED  + close >= MA20 (within 0.5%) + MA20 > SMA200
//  SHORT: RED candle  + prev GREEN + close <= MA20 (within 0.5%) + MA20 < SMA200
//
//  candles[-1] = FORMING (never used)
//  candles[-2] = last CLOSED bar  ← curr
//  candles[-3] = bar before that  ← prev
//  All MAs computed over CLOSED bars only (forming bar excluded).
//
function checkEntry(candles) {
  if (candles.length < SMA_PERIOD + 3) return null;

  const curr = candles[candles.length - 2];   // last CLOSED bar
  const prev = candles[candles.length - 3];   // bar before last closed

  // ── CANDLE TIME UNIT SAFETY ─────────────────────────────────────────────────
  // BingX should return ms, but guard against seconds (value < year-2000 in ms)
  const candleTime = curr.time < 1_000_000_000_000 ? curr.time * 1000 : curr.time;

  // ── FRESHNESS GUARD — MAX 2 CANDLE CLOSES AFTER SIGNAL ────────────────────
  // Signal candle (N) closes → valid entry window opens.
  // Entry allowed on 1st close (N+1) or 2nd close (N+2) after the signal.
  // Once the 3rd candle opens (age >= 2 × CANDLE_MS) → INVALID, no entry.
  //
  //   T=0            T=CANDLE_MS    T=CANDLE_MS×2
  //   Signal closes  1st close      2nd close  → HARD CUTOFF
  //   |─────── valid ────────────────|
  //
  // On 1m: valid window = 0–120s. Age ≥ 120s = SKIP.
  const signalAge = bingxNow() - (candleTime + CANDLE_MS);
  if (signalAge < 0)                return null;  // signal candle hasn't closed yet
  if (signalAge >= CANDLE_MS * 2)   return null;  // 2+ candles already closed → INVALID

  // ── MA over CLOSED bars only ────────────────────────────────────────────────
  const cc     = candles.slice(0, -1).map(c => c.close);
  const ma20   = sma(cc, MA_PERIOD);
  const sma200 = sma(cc, SMA_PERIOD);
  if (!ma20 || !sma200) return null;

  // ── SMA200 TREND BIAS ───────────────────────────────────────────────────────
  const bullish = ma20 > sma200;
  const bearish = ma20 < sma200;
  if (!bullish && !bearish) return null;  // MA20 == SMA200 → no clear trend

  // ── BODY SIZE ───────────────────────────────────────────────────────────────
  const bodyPct = Math.abs(curr.close - curr.open) / curr.open;
  if (bodyPct < MIN_BODY_PCT) return null;

  const currGreen = curr.close > curr.open;
  const currRed   = curr.close < curr.open;
  const prevRed   = prev.close < prev.open;
  const prevGreen = prev.close > prev.open;

  // ── MA20 PROXIMITY (max 0.5% from MA20) ────────────────────────────────────
  const distPct = Math.abs(curr.close - ma20) / ma20;
  if (distPct > MAX_MA_DIST_PCT) return null;  // price ran too far, don't chase

  // ── SIGNAL ─────────────────────────────────────────────────────────────────
  if (bullish && currGreen && prevRed   && curr.close >= ma20) return "LONG";
  if (bearish && currRed   && prevGreen && curr.close <= ma20) return "SHORT";
  return null;
}

// ── Exit signal ────────────────────────────────────────────────────────────────
//
//  LONG  exit: last closed bar crossed BELOW MA20
//              → currClose < currMA AND prevClose >= prevMA
//  SHORT exit: last closed bar crossed ABOVE MA20
//              → currClose > currMA AND prevClose <= prevMA
//
//  NO freshness guard here — exits must ALWAYS fire when crossover is detected.
//  Missing an exit is far worse than acting on a slightly old crossover.
//  Stop-loss handles runaway losses if exit is somehow delayed.
//
function checkExit(candles, side) {
  if (candles.length < SMA_PERIOD + 3) return false;

  // Closed bars only (exclude forming bar)
  const cc     = candles.slice(0, -1).map(c => c.close);
  const ccPrev = cc.slice(0, -1);

  const currClose = cc[cc.length - 1];
  const prevClose = ccPrev[ccPrev.length - 1];

  const currMA = sma(cc,     MA_PERIOD);
  const prevMA = sma(ccPrev, MA_PERIOD);
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
      // Safety: if time looks like seconds (< year 2001 in ms), convert to ms
      if (t > 0 && t < 1_000_000_000_000) t *= 1000;
      return { time: t, open: parseFloat(c.open), close: parseFloat(c.close) };
    });
    // Always sort ascending (oldest → newest) — BingX v3 may return newest-first
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

// ── Position sizing ────────────────────────────────────────────────────────────
function calcQty(bal, price) {
  if (!bal || !price) return 0;
  const margin   = Math.min(bal * RISK_PCT, MAX_MARGIN);
  const notional = margin * LEVERAGE;
  return Math.floor((notional / price) * 10) / 10;
}

// ── Place entry order ──────────────────────────────────────────────────────────
async function placeEntry(symbol, signal, bal) {
  try {
    const price = await getLivePrice(symbol);
    if (!price) { log(`SKIP ${symbol} — could not get live price`); return false; }

    const qty      = calcQty(bal, price);
    const notional = qty * price;
    if (qty <= 0 || notional < MIN_NOTIONAL) {
      log(`SKIP ${symbol} qty=${qty} notional=${notional.toFixed(2)} < min ${MIN_NOTIONAL}`);
      return false;
    }

    const side         = signal === "LONG" ? "BUY" : "SELL";
    const positionSide = signal;

    // Set leverage (ignore failure — already set or not supported)
    try { await POST("/openApi/swap/v2/trade/leverage", { symbol, side: signal, leverage: LEVERAGE }); } catch {}

    const r = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: qty
    });

    if (r?.code === 0) {
      stats.trades++;
      tradeToday++;
      log(`✅ ENTRY ${signal.padEnd(5)} ${symbol.padEnd(18)} qty=${qty} @~${price} ${LEVERAGE}x | today=${tradeToday}`);
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

// ── Place exit order ───────────────────────────────────────────────────────────
// knownPrice: if already known (e.g. from stop-loss check), skip extra API call
async function placeExit(symbol, positionSide, qty, entryPrice, knownPrice = 0) {
  try {
    const exitPrice = knownPrice || await getLivePrice(symbol);
    if (!exitPrice) { log(`SKIP EXIT ${symbol} — could not get live price`); return false; }

    const side = positionSide === "LONG" ? "SELL" : "BUY";
    const r    = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: Math.abs(qty)
    });

    if (r?.code === 0) {
      const margin   = Math.min(Math.abs(qty) * entryPrice / LEVERAGE, MAX_MARGIN);
      const pricePct = positionSide === "LONG"
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;
      const pnl      = pricePct * margin * LEVERAGE;
      const pnlPct   = pricePct * LEVERAGE * 100;

      perf.dailyPnl += pnl;
      if (pnl >= 0) perf.wins++; else perf.losses++;

      const total    = perf.wins + perf.losses;
      const winRatio = total ? ((perf.wins / total) * 100).toFixed(1) : "0.0";
      const icon     = pnl >= 0 ? "✅" : "❌";

      stats.lastExit = new Date().toISOString();
      log(`${icon} EXIT  ${positionSide.padEnd(5)} ${symbol.padEnd(18)} price:${(pricePct*100).toFixed(3)}% margin:${pnlPct.toFixed(2)}% | PnL:$${pnl.toFixed(2)} | Daily:$${perf.dailyPnl.toFixed(2)} | W/L:${perf.wins}/${perf.losses}(${winRatio}%)`);
      return true;
    } else {
      log(`❌ EXIT FAIL   ${symbol} code=${r?.code} msg=${r?.msg}`);
      return false;
    }
  } catch (e) {
    stats.errors++;
    log(`❌ EXIT ERROR  ${symbol}: ${e.message}`);
    return false;
  }
}

// ── Entry scan (every SCAN_MS) ─────────────────────────────────────────────────
let scanning = false;
async function scanEntry() {
  if (scanning) return;
  scanning = true;
  try {
    checkDailyReset();
    stats.lastScan = new Date().toISOString();

    const positions = await getOpenPositions();
    if (positions.length >= MAX_OPEN) return;
    if (tradeToday >= MAX_DAILY) return;

    // FIX: skip scan if no balance
    let bal = await getBalance();
    if (bal <= 0) { log(`⏸  Balance=0, skipping entry scan`); return; }

    const busy     = new Set(positions.map(p => p.symbol));
    let openCount  = positions.length;
    let signals    = 0;

    log(`═ SCAN | bal=${bal.toFixed(2)} | open=${openCount}/${MAX_OPEN} | today=${tradeToday}/${MAX_DAILY}`);

    for (const sym of WATCHLIST) {
      if (busy.has(sym))            continue;
      if (tradeToday >= MAX_DAILY)  break;
      if (openCount  >= MAX_OPEN)   break;

      const cv = await getCandles(sym);
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));

      const sig = checkEntry(cv);
      if (!sig) continue;

      signals++;
      const lastBar = cv[cv.length - 2];
      const cc      = cv.slice(0, -1).map(c => c.close);
      const ma20val = sma(cc, MA_PERIOD) || 0;
      const dist    = ma20val ? ((Math.abs(lastBar.close - ma20val) / ma20val) * 100).toFixed(3) : "?";
      const age     = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      log(`📊 SIGNAL ${sig.padEnd(5)} ${sym.padEnd(18)} dist:${dist}% from MA20 | age:${age}s`);

      const placed = await placeEntry(sym, sig, bal);
      if (placed) {
        openCount++;
        busy.add(sym);
        // FIX: refresh balance after each trade so next order uses updated margin
        bal = await getBalance();
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
      }
    }

    if (signals > 0) log(`═ SCAN DONE | signals=${signals} | trades_today=${tradeToday}`);
  } catch (e) {
    stats.errors++;
    log(`SCAN CRASH: ${e.message}`);
  } finally {
    scanning = false;
  }
}

// ── Exit monitor (every EXIT_POLL_MS) ─────────────────────────────────────────
//
// Per position, checks in this order:
//   1. STOP-LOSS: -3% PnL on margin (live price, IMMEDIATE)
//   2. MA20 CROSSOVER: close crossed MA20 on last closed candle
//
// NOTE: checkExit has NO freshness guard — exits must never be blocked.
//
let polling = false;
async function pollExits() {
  if (polling) return;
  polling = true;
  try {
    const positions = await getOpenPositions();
    if (!positions.length) return;

    for (const pos of positions) {
      const sym   = pos.symbol;
      const side  = pos.positionSide;
      const qty   = parseFloat(pos.positionAmt || 0);
      const entry = parseFloat(pos.avgPrice    || pos.entryPrice || 0);

      if (!qty || !["LONG", "SHORT"].includes(side)) continue;
      if (!entry) continue;

      // ── STEP 1: STOP-LOSS ─────────────────────────────────────────────────────
      let pnlPct    = null;
      let pnlUsd    = null;
      let pnlSource = "";
      let livePrice = 0;

      // Method A: BingX's own unrealizedProfit / initialMargin (most accurate)
      const bxPnl    = parseFloat(pos.unrealizedProfit ?? "NaN");
      const bxMargin = parseFloat(pos.initialMargin    ?? pos.margin ?? "NaN");
      if (isFinite(bxPnl) && isFinite(bxMargin) && bxMargin > 0) {
        pnlPct    = bxPnl / bxMargin;
        pnlUsd    = bxPnl;
        pnlSource = "bingx";
      }

      // Method B: fallback — live price × leverage
      if (pnlPct === null) {
        livePrice = await getLivePrice(sym);
        if (livePrice > 0) {
          const pricePct = side === "LONG"
            ? (livePrice - entry) / entry
            : (entry - livePrice) / entry;
          pnlPct    = pricePct * LEVERAGE;
          const margin = Math.min(Math.abs(qty) * entry / LEVERAGE, MAX_MARGIN);
          pnlUsd    = pricePct * margin * LEVERAGE;
          pnlSource = "live";
        }
      }

      if (pnlPct !== null && pnlPct <= -STOP_LOSS_PCT) {
        log(`🛑 STOP LOSS  ${side.padEnd(5)} ${sym.padEnd(18)} | PnL:${(pnlPct*100).toFixed(2)}% $${(pnlUsd??0).toFixed(2)} [${pnlSource}] → CLOSING`);
        // FIX: pass livePrice to placeExit so it doesn't need to fetch again
        await placeExit(sym, side, qty, entry, livePrice || 0);
        await new Promise(r => setTimeout(r, ORDER_DELAY_MS));
        continue;
      }

      // ── STEP 2: MA20 CROSSOVER ────────────────────────────────────────────────
      const cv = await getCandles(sym);
      await new Promise(r => setTimeout(r, FETCH_DELAY_MS));
      if (!cv.length) continue;
      if (!checkExit(cv, side)) continue;

      const lastBar = cv[cv.length - 2];
      const age     = Math.round((bingxNow() - (lastBar.time + CANDLE_MS)) / 1000);
      log(`🔔 EXIT  ${side.padEnd(5)} ${sym.padEnd(18)} MA20 crossover | age:${age}s`);
      await placeExit(sym, side, qty, entry);
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
  } else if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...stats, perf, log: undefined, recentLog: stats.log.slice(-50) }, null, 2));
  } else {
    const total    = perf.wins + perf.losses;
    const winRatio = total ? `${((perf.wins / total) * 100).toFixed(1)}%` : "0%";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:   "🟢 running",
      strategy: `${RULES.strategy_name} v${RULES.version} | MA${MA_PERIOD}/SMA${SMA_PERIOD} | ${TIMEFRAME}`,
      uptime:   Math.round(process.uptime()) + "s",
      trades:   stats.trades,
      today:    `${tradeToday}/${MAX_DAILY}`,
      errors:   stats.errors,
      lastScan: stats.lastScan,
      lastExit: stats.lastExit,
      perf:     { wins: perf.wins, losses: perf.losses, winRatio, dailyPnl: `$${perf.dailyPnl.toFixed(2)}` },
      config:   {
        timeframe: TIMEFRAME, leverage: `${LEVERAGE}x`, riskPct: `${RISK_PCT*100}%`,
        maxMargin: `$${MAX_MARGIN}`, stopLoss: `-${STOP_LOSS_PCT*100}%`,
        maxMaDist: `${MAX_MA_DIST_PCT*100}%`, watchlist: WATCHLIST.length,
        scan: `${SCAN_MS/1000}s`, exit: `${EXIT_POLL_MS/1000}s`
      }
    }, null, 2));
  }
}).listen(PORT, () => log(`🌐 Dashboard → http://localhost:${PORT}`));

// ── Boot ───────────────────────────────────────────────────────────────────────
await syncClock();
log(`🤖 ${RULES.strategy_name} v${RULES.version} — MA Scalper Bot`);
log(`   Timeframe : ${TIMEFRAME} | MA${MA_PERIOD} | SMA${SMA_PERIOD} | Bias: MA20 vs SMA200`);
log(`   Entry     : within ${MAX_MA_DIST_PCT*100}% of MA20 | fresh <${CANDLE_MS*1.5/1000}s | body >${MIN_BODY_PCT*100}%`);
log(`   Exit      : MA20 crossover (no freshness limit) | stop-loss -${STOP_LOSS_PCT*100}% PnL`);
log(`   Sizing    : ${RISK_PCT*100}% risk | ${LEVERAGE}x leverage | max $${MAX_MARGIN} margin`);
log(`   Timing    : scan=${SCAN_MS/1000}s | exit=${EXIT_POLL_MS/1000}s | fetch=${FETCH_DELAY_MS}ms | order=${ORDER_DELAY_MS}ms`);
log(`   Watchlist : ${WATCHLIST.length} symbols | ${BLACKLIST.size} blacklisted`);
log(`   Limits    : ${MAX_OPEN} open | ${MAX_DAILY}/day`);

await scanEntry();
setInterval(scanEntry,  SCAN_MS);
setInterval(pollExits,  EXIT_POLL_MS);
