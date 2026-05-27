/**
 * BingX Demo Trading Bot — MA20 Scalper (Consolidated)
 * Single process: entry scan + exit monitor
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
const BASE_URL      = "https://open-api-vst.bingx.com";
const TIMEFRAME     = RULES.timeframe;                          // "1m"
const MA_PERIOD     = RULES.indicators.MA20.length;             // 20
const SMA_PERIOD    = RULES.indicators.SMA200.length;           // 200
const LEVERAGE      = RULES.position_sizing.leverage;           // 5
const RISK_PCT      = RULES.position_sizing.risk_pct;           // 0.01
const MAX_MARGIN    = RULES.position_sizing.max_margin;         // 500
const MAX_OPEN      = RULES.limits.max_open_positions;          // 20
const MAX_DAILY     = RULES.limits.max_trades_per_day;          // 500
const API_DELAY_MS  = RULES.limits.api_delay_ms;                // 1000
const SCAN_MS       = RULES.limits.scan_interval_ms;            // 10000
const EXIT_POLL_MS  = 10000;   // rules.exit.logic.check_interval = "Every 10 seconds"
const MIN_BODY_PCT  = 0.0002;  // rules.entry.logic.body_size_check = 0.02%
const STOP_LOSS_PCT = RULES.limits.stop_loss_pct || 0.015;
const BLACKLIST     = new Set(RULES.blacklist || []);
const WATCHLIST     = (RULES.watchlist || []).filter(s => !BLACKLIST.has(s));
const PORT          = process.env.PORT || 3000;

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

// ── Clock sync (BingX server time offset) ─────────────────────────────────────
let clockOffset = 0;
async function syncClock() {
  try {
    const r = await axios.get(`${BASE_URL}/openApi/swap/v2/server/time`, { timeout: 5000 });
    clockOffset = (r.data?.data?.serverTime || Date.now()) - Date.now();
    log(`⏱  Clock synced: offset=${clockOffset}ms (${Math.round(clockOffset / 3600000)}h)`);
  } catch (e) { log(`WARN: clock sync failed — ${e.message}`); }
}
const bingxNow = () => Date.now() + clockOffset;

// ── API helpers ────────────────────────────────────────────────────────────────
// Sign over sorted params, build query string in same sorted order (BingX requires order match)
function buildQS(params, secret) {
  const keys = Object.keys(params).sort();
  const str  = keys.map(k => `${k}=${params[k]}`).join("&");
  const sig  = crypto.createHmac("sha256", secret).update(str).digest("hex");
  return keys.map(k => `${k}=${encodeURIComponent(params[k])}`).join("&") + `&signature=${sig}`;
}

async function GET(path, params = {}) {
  const { k, s } = creds();
  const qs = buildQS({ ...params, timestamp: bingxNow() }, s);
  const r  = await axios.get(`${BASE_URL}${path}?${qs}`, { headers: { "X-BX-APIKEY": k }, timeout: 10000 });
  return r.data;
}

async function POST(path, params = {}) {
  const { k, s } = creds();
  const qs = buildQS({ ...params, timestamp: bingxNow() }, s);
  const r  = await axios.post(`${BASE_URL}${path}?${qs}`, null, {
    headers: { "X-BX-APIKEY": k }, timeout: 10000
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

// ── MA / SMA ───────────────────────────────────────────────────────────────────
function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Entry signal ───────────────────────────────────────────────────────────────
// LONG:  GREEN candle (close>open), prev RED (close<open), close >= MA20, body >= 0.02%
//        BIAS: only if MA20 > SMA200 strictly (bullish trend)
// SHORT: RED candle  (close<open), prev GREEN(close>open), close <= MA20, body >= 0.02%
//        BIAS: only if MA20 < SMA200 strictly (bearish trend)
// MA20 == SMA200 → no entries (no clear trend)
// Uses last CLOSED candle (skip the currently-forming bar at index -1)
function checkEntry(candles) {
  if (candles.length < SMA_PERIOD + 3) return null;

  const curr   = candles[candles.length - 2];  // last closed candle
  const prev   = candles[candles.length - 3];  // candle before that
  const closes = candles.map(c => c.close);

  const currMA20  = sma(closes, MA_PERIOD);
  const currSMA200 = sma(closes, SMA_PERIOD);
  if (!currMA20 || !currSMA200) return null;

  // ── SMA200 BIAS FILTER ──────────────────────────────────────────────────────
  // MA20 strictly > SMA200 → bullish trend, LONG only
  // MA20 strictly < SMA200 → bearish trend, SHORT only
  // MA20 == SMA200          → no clear trend, skip
  const bullish = currMA20 > currSMA200;
  const bearish = currMA20 < currSMA200;
  if (!bullish && !bearish) return null;  // exactly equal → skip

  const bodyPct = Math.abs(curr.close - curr.open) / curr.open;
  if (bodyPct < MIN_BODY_PCT) return null;

  const currGreen = curr.close > curr.open;
  const currRed   = curr.close < curr.open;
  const prevRed   = prev.close < prev.open;
  const prevGreen = prev.close > prev.open;

  if (bullish && currGreen && prevRed   && curr.close >= currMA20) return "LONG";
  if (bearish && currRed   && prevGreen && curr.close <= currMA20) return "SHORT";
  return null;
}

// ── Exit signal ────────────────────────────────────────────────────────────────
// LONG exit:  curr.close < MA20 AND prev.close >= MA20  (price crossed below)
// SHORT exit: curr.close > MA20 AND prev.close <= MA20  (price crossed above)
// Uses last CLOSED candle (skip the currently-forming bar at index -1)
function checkExit(candles, side) {
  if (candles.length < SMA_PERIOD + 3) return false;

  const closes    = candles.map(c => c.close);
  const currClose = closes[closes.length - 2];  // last closed candle
  const prevClose = closes[closes.length - 3];  // candle before that
  const currMA    = sma(closes, MA_PERIOD);
  const prevMA    = sma(closes.slice(0, -1), MA_PERIOD);
  if (!currMA || !prevMA) return false;

  if (side === "LONG")  return currClose < currMA  && prevClose >= prevMA;
  if (side === "SHORT") return currClose > currMA  && prevClose <= prevMA;
  return false;
}

// ── Market data ────────────────────────────────────────────────────────────────
async function getCandles(symbol) {
  try {
    const d = await GET("/openApi/swap/v3/quote/klines", {
      symbol, interval: TIMEFRAME, limit: SMA_PERIOD + 4   // 204 — enough for SMA200
    });
    if (!Array.isArray(d?.data)) return [];
    // v3 klines returns objects: { open, high, low, close, volume, time }
    return d.data.map(c => ({ time: c.time, open: parseFloat(c.open), close: parseFloat(c.close) }));
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
// qty = floor((min(balance × 0.01, 500) × 5) / price, 1 decimal)
function calcQty(bal, price) {
  const margin   = Math.min(bal * RISK_PCT, MAX_MARGIN);
  const notional = margin * LEVERAGE;
  return Math.floor((notional / price) * 10) / 10;
}

// ── Place entry order ──────────────────────────────────────────────────────────
async function placeEntry(symbol, signal, bal) {
  try {
    const price = await getLivePrice(symbol);
    if (!price) return;

    const qty      = calcQty(bal, price);
    const notional = qty * price;
    if (qty <= 0 || notional < RULES.position_sizing.min_notional) {
      log(`SKIP ${symbol} qty=${qty} notional=${notional.toFixed(2)} < min`); return;
    }

    const side         = signal === "LONG" ? "BUY" : "SELL";
    const positionSide = signal;

    try { await POST("/openApi/swap/v2/trade/leverage", { symbol, side: signal, leverage: LEVERAGE }); } catch {}

    const r = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: qty
    });

    if (r?.code === 0) {
      stats.trades++;
      tradeToday++;
      log(`✅ ENTRY ${signal.padEnd(5)} ${symbol.padEnd(18)} qty=${qty} @${price} ${LEVERAGE}x`);
      return true;
    } else {
      log(`❌ ENTRY FAIL  ${symbol} → ${JSON.stringify(r)}`);
    }
  } catch (e) {
    stats.errors++;
    log(`❌ ENTRY ERROR ${symbol}: ${e.message}`);
  }
}

// ── Place exit order ───────────────────────────────────────────────────────────
async function placeExit(symbol, positionSide, qty, entryPrice) {
  try {
    const exitPrice = await getLivePrice(symbol);
    if (!exitPrice) return;

    const side = positionSide === "LONG" ? "SELL" : "BUY";
    const r    = await POST("/openApi/swap/v2/trade/order", {
      symbol, side, positionSide, type: "MARKET", quantity: Math.abs(qty)
    });

    if (r?.code === 0) {
      const margin   = Math.min(Math.abs(qty) * entryPrice / LEVERAGE, MAX_MARGIN);
      const pnl      = positionSide === "LONG"
        ? (exitPrice - entryPrice) / entryPrice * margin * LEVERAGE
        : (entryPrice - exitPrice) / entryPrice * margin * LEVERAGE;

      perf.dailyPnl += pnl;
      if (pnl >= 0) perf.wins++; else perf.losses++;

      const total    = perf.wins + perf.losses;
      const winRatio = total ? ((perf.wins / total) * 100).toFixed(1) : "0.0";
      const pct      = ((exitPrice - entryPrice) / entryPrice * 100).toFixed(3);
      const icon     = pnl >= 0 ? "✅" : "❌";

      stats.lastExit = new Date().toISOString();
      log(`${icon} EXIT  ${positionSide.padEnd(5)} ${symbol.padEnd(18)} ${pct}% | PnL: $${pnl.toFixed(2)} | Daily: $${perf.dailyPnl.toFixed(2)} | W/L: ${perf.wins}/${perf.losses} (${winRatio}%)`);
    } else {
      log(`❌ EXIT FAIL   ${symbol} → ${JSON.stringify(r)}`);
    }
  } catch (e) {
    stats.errors++;
    log(`❌ EXIT ERROR  ${symbol}: ${e.message}`);
  }
}

// ── Entry scan (every SCAN_MS = 10s) ──────────────────────────────────────────
let scanning = false;
async function scanEntry() {
  if (scanning) return;
  scanning = true;
  try {
    checkDailyReset();
    stats.lastScan = new Date().toISOString();

    const positions = await getOpenPositions();
    if (positions.length >= MAX_OPEN) {
      log(`⏸  Max open positions (${MAX_OPEN}) — skipping entry scan`);
      return;
    }
    if (tradeToday >= MAX_DAILY) {
      log(`⏸  Daily trade limit (${MAX_DAILY}) — skipping entry scan`);
      return;
    }

    const bal  = await getBalance();
    const busy = new Set(positions.map(p => p.symbol));

    log(`═ ENTRY SCAN | bal=${bal.toFixed(2)} | open=${positions.length}/${MAX_OPEN} | today=${tradeToday}/${MAX_DAILY}`);

    let signals  = 0;
    let openCount = positions.length;  // track running total mid-scan
    for (const sym of WATCHLIST) {
      if (busy.has(sym))           continue;
      if (tradeToday >= MAX_DAILY) break;
      if (openCount  >= MAX_OPEN)  break;  // enforce cap mid-scan

      await new Promise(r => setTimeout(r, API_DELAY_MS));

      const cv  = await getCandles(sym);
      const sig = checkEntry(cv);
      if (!sig) continue;

      signals++;
      log(`📊 SIGNAL ${sig.padEnd(5)} ${sym}`);
      const placed = await placeEntry(sym, sig, bal);
      if (placed) { openCount++; busy.add(sym); }
    }

    if (signals > 0) log(`═ ENTRY SCAN DONE | signals=${signals} | trades_today=${tradeToday}`);
  } catch (e) {
    stats.errors++;
    log(`SCAN CRASH: ${e.message}`);
  } finally {
    scanning = false;
  }
}

// ── Exit monitor (every EXIT_POLL_MS = 10s, independent loop) ─────────────────
// Priority order per position:
//   1. LIVE price stop-loss check first  (-3% unrealized PnL → IMMEDIATE exit)
//   2. MA20 crossover check via candles  (only if stop-loss not triggered)
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
      const qty   = parseFloat(pos.positionAmt  || 0);
      const entry = parseFloat(pos.avgPrice     || pos.entryPrice || 0);

      if (!qty || !["LONG", "SHORT"].includes(side)) continue;
      if (!entry) continue;

      // ── STEP 1: STOP-LOSS via LIVE price (fast, no candle fetch needed) ──────
      const livePrice = await getLivePrice(sym);
      if (livePrice > 0) {
        const unrealizedPct = side === "LONG"
          ? (livePrice - entry) / entry
          : (entry - livePrice) / entry;

        if (unrealizedPct <= -STOP_LOSS_PCT) {
          const margin = Math.min(Math.abs(qty) * entry / LEVERAGE, MAX_MARGIN);
          const pnlUsd = unrealizedPct * margin * LEVERAGE;
          log(`🛑 STOP LOSS  ${side.padEnd(5)} ${sym} — ${(unrealizedPct * 100).toFixed(3)}% | ~$${pnlUsd.toFixed(2)} | livePrice=${livePrice}`);
          await placeExit(sym, side, qty, entry);
          await new Promise(r => setTimeout(r, API_DELAY_MS));
          continue;  // skip MA20 check for this position
        }
      }

      // ── STEP 2: MA20 crossover check (requires candle history) ───────────────
      const cv = await getCandles(sym);
      if (!cv.length) continue;

      if (!checkExit(cv, side)) continue;

      log(`🔔 EXIT SIGNAL ${side.padEnd(5)} ${sym} — MA20 crossover`);
      await placeExit(sym, side, qty, entry);
      await new Promise(r => setTimeout(r, API_DELAY_MS));
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
      status:      "🟢 running",
      strategy:    `${RULES.strategy_name} v${RULES.version} | MA${MA_PERIOD} | ${TIMEFRAME}`,
      uptime:      Math.round(process.uptime()) + "s",
      trades:      stats.trades,
      todayTrades: `${tradeToday}/${MAX_DAILY}`,
      errors:      stats.errors,
      lastScan:    stats.lastScan,
      lastExit:    stats.lastExit,
      perf:        { wins: perf.wins, losses: perf.losses, winRatio, dailyPnl: `$${perf.dailyPnl.toFixed(2)}` },
      config:      { timeframe: TIMEFRAME, maPeriod: MA_PERIOD, leverage: `${LEVERAGE}x`, riskPct: `${RISK_PCT * 100}%`, maxMargin: `$${MAX_MARGIN}`, maxOpen: MAX_OPEN, watchlist: WATCHLIST.length }
    }, null, 2));
  }
}).listen(PORT, () => log(`🌐 Dashboard → http://localhost:${PORT}`));

// ── Boot ───────────────────────────────────────────────────────────────────────
await syncClock();
log(`🤖 ${RULES.strategy_name} v${RULES.version} — Consolidated Bot`);
log(`   Timeframe  : ${TIMEFRAME}  |  MA20=${MA_PERIOD}  |  SMA200=${SMA_PERIOD}`);
log(`   Bias       : LONG only when MA20>SMA200 | SHORT only when MA20<SMA200`);
log(`   Leverage   : ${LEVERAGE}x  |  Risk       : ${RISK_PCT * 100}%  |  Max margin : $${MAX_MARGIN}`);
log(`   Watchlist  : ${WATCHLIST.length} symbols (${BLACKLIST.size} blacklisted)`);
log(`   Entry scan : every ${SCAN_MS / 1000}s  |  Exit poll : every ${EXIT_POLL_MS / 1000}s`);
log(`   Stop-loss  : -${STOP_LOSS_PCT * 100}% unrealized PnL (live price, IMMEDIATE)`);
log(`   Limits     : ${MAX_OPEN} open positions | ${MAX_DAILY} trades/day | ${API_DELAY_MS}ms API delay`);

await scanEntry();
setInterval(scanEntry, SCAN_MS);
setInterval(pollExits, EXIT_POLL_MS);
