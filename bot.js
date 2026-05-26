/**
 * BingX Demo Trading Bot — MA20 Crossover Strategy
 * Scans top 50 symbols every 5 min on 5m candles
 * 5x leverage | 1% balance per trade | Long & Short
 */

import axios from "axios";
import crypto from "crypto";
import { readFileSync, existsSync } from "fs";
import http from "http";

// ── Config ─────────────────────────────────────────────────────────────────────
const BASE_URL    = "https://open-api-vst.bingx.com";
const LEVERAGE    = 5;
const RISK_PCT    = 0.01;        // 1% of available balance per trade
const TIMEFRAME   = "5m";
const MA_PERIOD   = 20;
const TOP_N       = 50;
const SCAN_MS     = 5 * 60 * 1000;  // 5 minutes
const PORT        = process.env.PORT || 3000;

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
    return {
      k: vars.BINGX_API_KEY    || "",
      s: vars.BINGX_SECRET_KEY || vars.BINGX_API_SECRET || ""
    };
  } catch { return { k: "", s: "" }; }
}

// ── API helpers ────────────────────────────────────────────────────────────────
function sign(params, secret) {
  const q = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  return crypto.createHmac("sha256", secret).update(q).digest("hex");
}

async function GET(path, params = {}) {
  const { k, s } = creds();
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, s);
  const r = await axios.get(`${BASE_URL}${path}`, { params: p, headers: { "X-BX-APIKEY": k }, timeout: 10000 });
  return r.data;
}

async function POST(path, params = {}) {
  const { k, s } = creds();
  const p = { ...params, timestamp: Date.now() };
  p.signature = sign(p, s);
  const qs = Object.entries(p).map(([a, b]) => `${a}=${encodeURIComponent(b)}`).join("&");
  const r = await axios.post(`${BASE_URL}${path}?${qs}`, null, {
    headers: { "X-BX-APIKEY": k, "Content-Type": "application/json" }, timeout: 10000
  });
  return r.data;
}

// ── Stats & Logging ────────────────────────────────────────────────────────────
const stats = { start: new Date().toISOString(), lastScan: null, trades: 0, errors: 0, log: [] };

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  stats.log.push(line);
  if (stats.log.length > 1000) stats.log.shift();
}

// ── Rules.json ─────────────────────────────────────────────────────────────────
function loadRules() {
  for (const p of ["./rules.json", "C:/Users/ALEXIS/bingx-mcp/rules.json"]) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch {}
  }
  return { rules: [] };
}

// ── MA20 ───────────────────────────────────────────────────────────────────────
function ma(closes, period) {
  if (closes.length < period) return null;
  const sl = closes.slice(-period);
  return sl.reduce((a, b) => a + b, 0) / period;
}

function crossoverSignal(candles) {
  if (candles.length < MA_PERIOD + 2) return null;
  const closes = candles.map(c => c.close);

  const prevMA  = ma(closes.slice(0, -1), MA_PERIOD);
  const currMA  = ma(closes,              MA_PERIOD);
  if (!prevMA || !currMA) return null;

  const prevC = closes[closes.length - 2];
  const currC = closes[closes.length - 1];

  if (prevC < prevMA && currC > currMA) return "LONG";
  if (prevC > prevMA && currC < currMA) return "SHORT";
  return null;
}

// ── Market data ────────────────────────────────────────────────────────────────
async function topSymbols() {
  try {
    const d = await GET("/openApi/swap/v2/quote/ticker");
    const tickers = Array.isArray(d?.data) ? d.data : Object.values(d?.data || {});
    return tickers
      .filter(t => t.symbol?.endsWith("-USDT"))
      .sort((a, b) => parseFloat(b.quoteVolume || b.volume || 0) - parseFloat(a.quoteVolume || a.volume || 0))
      .slice(0, TOP_N)
      .map(t => t.symbol);
  } catch (e) {
    log(`WARN: topSymbols failed (${e.message}) — using fallback list`);
    return ["BTC-USDT","ETH-USDT","SOL-USDT","BNB-USDT","XRP-USDT","DOGE-USDT","ADA-USDT","AVAX-USDT","DOT-USDT","MATIC-USDT"];
  }
}

async function candles(symbol) {
  try {
    const d = await GET("/openApi/swap/v3/quote/klines", { symbol, interval: TIMEFRAME, limit: MA_PERIOD + 2 });
    if (!d?.data) return [];
    return d.data.map(c => ({ close: parseFloat(c[4]), time: c[0] }));
  } catch { return []; }
}

async function balance() {
  try {
    const d = await GET("/openApi/swap/v2/user/balance");
    return parseFloat(d?.data?.balance?.availableMargin || 0);
  } catch { return 0; }
}

async function openPositions() {
  try {
    const d = await GET("/openApi/swap/v2/user/positions");
    return d?.data || [];
  } catch { return []; }
}

async function livePrice(symbol) {
  try {
    const d = await GET("/openApi/swap/v2/quote/price", { symbol });
    return parseFloat(d?.data?.price || 0);
  } catch { return 0; }
}

// ── Order placement ────────────────────────────────────────────────────────────
function roundQty(qty, price) {
  if (price > 10000) return Math.round(qty * 1000) / 1000;   // BTC-level
  if (price > 100)   return Math.round(qty * 100)  / 100;    // ETH-level
  if (price > 1)     return Math.round(qty * 10)   / 10;     // SOL-level
  return Math.round(qty);                                     // Low-price alts
}

async function placeOrder(symbol, signal, bal) {
  try {
    const price = await livePrice(symbol);
    if (!price) return;

    const notional = bal * RISK_PCT;            // e.g. 614 VST
    const qty      = roundQty(notional / price, price);
    if (qty <= 0) return;

    const side         = signal === "LONG" ? "BUY"  : "SELL";
    const positionSide = signal === "LONG" ? "LONG" : "SHORT";

    // Set leverage
    try { await POST("/openApi/swap/v2/trade/leverage", { symbol, side, leverage: LEVERAGE }); } catch {}

    // Place market order
    const r = await POST("/openApi/swap/v2/trade/order", { symbol, side, positionSide, type: "MARKET", quantity: qty });

    if (r?.code === 0) {
      stats.trades++;
      log(`✅ TRADE  ${signal.padEnd(5)} ${symbol.padEnd(12)} qty=${qty} price=${price} leverage=${LEVERAGE}x`);
    } else {
      log(`❌ FAILED ${signal.padEnd(5)} ${symbol.padEnd(12)} → ${JSON.stringify(r)}`);
    }
  } catch (e) {
    stats.errors++;
    log(`❌ ERROR  ${symbol} order: ${e.message}`);
  }
}

// ── Main scan ──────────────────────────────────────────────────────────────────
async function scan() {
  stats.lastScan = new Date().toISOString();
  log("═══ SCAN START ═══");

  try {
    const bal  = await balance();
    const pos  = await openPositions();
    const busy = new Set(pos.map(p => p.symbol));
    const syms = await topSymbols();

    log(`Balance=${bal.toFixed(2)} VST  |  Open=${pos.length}  |  Scanning ${syms.length} symbols`);

    let signals = 0;
    for (const sym of syms) {
      if (busy.has(sym)) continue;                        // skip symbols with open position
      await new Promise(r => setTimeout(r, 120));         // gentle rate-limit between symbols

      const cv = await candles(sym);
      const sig = crossoverSignal(cv);
      if (!sig) continue;

      signals++;
      log(`📊 SIGNAL ${sig.padEnd(5)} ${sym}`);
      await placeOrder(sym, sig, bal);
    }

    log(`═══ SCAN END  signals=${signals} total_trades=${stats.trades} ═══`);
  } catch (e) {
    stats.errors++;
    log(`SCAN CRASH: ${e.message}`);
  }
}

// ── HTTP server (Railway health check + dashboard) ─────────────────────────────
http.createServer((req, res) => {
  if (req.url === "/log") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(stats.log.slice(-200).join("\n"));
  } else if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...stats, log: undefined, recentLog: stats.log.slice(-50) }, null, 2));
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:    "🟢 running",
      uptime:    Math.round(process.uptime()) + "s",
      trades:    stats.trades,
      errors:    stats.errors,
      lastScan:  stats.lastScan,
      strategy:  `MA${MA_PERIOD} crossover | ${TIMEFRAME} | top ${TOP_N} symbols`,
      leverage:  `${LEVERAGE}x`,
      riskPct:   `${RISK_PCT * 100}%`,
    }));
  }
}).listen(PORT, () => log(`🌐 Dashboard → http://localhost:${PORT}`));

// ── Boot ───────────────────────────────────────────────────────────────────────
log("🤖 BingX Demo Bot — MA20 Crossover Strategy");
log(`   Timeframe : ${TIMEFRAME}  |  MA period : ${MA_PERIOD}`);
log(`   Leverage  : ${LEVERAGE}x  |  Risk      : ${RISK_PCT * 100}% per trade`);
log(`   Symbols   : Top ${TOP_N} by volume`);
log(`   Scan      : every ${SCAN_MS / 60000} min`);

await scan();
setInterval(scan, SCAN_MS);
