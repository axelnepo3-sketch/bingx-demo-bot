import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from "axios";
import crypto from "crypto";
import { readFileSync, existsSync } from "fs";

const BASE_URL = "https://open-api-vst.bingx.com"; // BingX demo (simulated trading)
const ENV_PATH = "C:/Users/ALEXIS/bingx-mcp/.env";

// ── Read credentials directly from .env file (bypasses process.env issues) ────

function getCredentials() {
  // 1. Try process.env first (Desktop app env injection)
  const fromEnv = {
    key: process.env.BINGX_API_KEY || "",
    secret: process.env.BINGX_API_SECRET || process.env.BINGX_SECRET_KEY || "",
  };
  if (fromEnv.key && fromEnv.secret) return fromEnv;

  // 2. Fall back to reading .env file directly
  try {
    const raw = readFileSync(ENV_PATH, "utf8");
    const lines = raw.split(/\r?\n/);
    const vars = {};
    for (const line of lines) {
      const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.+?)\s*$/);
      if (match) vars[match[1]] = match[2];
    }
    return {
      key: vars.BINGX_API_KEY || "",
      secret: vars.BINGX_API_SECRET || vars.BINGX_SECRET_KEY || "",
    };
  } catch {
    return { key: "", secret: "" };
  }
}

// ── Auth helpers ───────────────────────────────────────────────────────────────

function sign(params, secret) {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

async function bingxGet(path, params = {}) {
  const { key, secret } = getCredentials();
  const ts = Date.now();
  const payload = { ...params, timestamp: ts };
  payload.signature = sign(payload, secret);
  const res = await axios.get(`${BASE_URL}${path}`, {
    params: payload,
    headers: { "X-BX-APIKEY": key },
  });
  return res.data;
}

async function bingxPost(path, params = {}) {
  const { key, secret } = getCredentials();
  const ts = Date.now();
  const payload = { ...params, timestamp: ts };
  payload.signature = sign(payload, secret);
  const qs = Object.entries(payload)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await axios.post(`${BASE_URL}${path}?${qs}`, null, {
    headers: { "X-BX-APIKEY": key },
  });
  return res.data;
}

async function bingxDelete(path, params = {}) {
  const { key, secret } = getCredentials();
  const ts = Date.now();
  const payload = { ...params, timestamp: ts };
  payload.signature = sign(payload, secret);
  const res = await axios.delete(`${BASE_URL}${path}`, {
    params: payload,
    headers: { "X-BX-APIKEY": key },
  });
  return res.data;
}

// ── Load rules ─────────────────────────────────────────────────────────────────

function loadRules() {
  const rulesPath = "C:/Users/ALEXIS/bingx-mcp/rules.json";
  if (!existsSync(rulesPath)) return null;
  try {
    return JSON.parse(readFileSync(rulesPath, "utf8"));
  } catch {
    return null;
  }
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "bingx-demo",
  version: "1.0.0",
});

// ── Tools ──────────────────────────────────────────────────────────────────────

server.tool(
  "health_check",
  "Check BingX demo API connectivity and confirm API keys are working",
  {},
  async () => {
    const { key, secret } = getCredentials();
    if (!key || !secret) {
      const envFileExists = existsSync(ENV_PATH);
      return {
        content: [{
          type: "text",
          text: [
            "ERROR: BingX API credentials not found.",
            `ENV file exists: ${envFileExists}`,
            `BINGX_API_KEY in process.env: ${!!process.env.BINGX_API_KEY}`,
            `BINGX_SECRET_KEY in process.env: ${!!process.env.BINGX_SECRET_KEY}`,
            `ENV_PATH: ${ENV_PATH}`,
          ].join("\n"),
        }],
      };
    }
    try {
      const data = await bingxGet("/openApi/swap/v2/user/balance");
      return {
        content: [{ type: "text", text: `✅ Connected to BingX demo!\nKey: ${key.slice(0,8)}...\n\n${JSON.stringify(data, null, 2)}` }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Connection failed: ${e.message}\n${e.response?.data ? JSON.stringify(e.response.data) : ""}` }] };
    }
  }
);

server.tool(
  "get_price",
  "Get the latest mark price for a BingX perpetual futures symbol (e.g. BTC-USDT)",
  { symbol: z.string().describe("Symbol, e.g. BTC-USDT") },
  async ({ symbol }) => {
    try {
      const data = await bingxGet("/openApi/swap/v2/quote/price", { symbol });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_klines",
  "Get OHLCV candlestick data for a symbol",
  {
    symbol: z.string().describe("Symbol, e.g. BTC-USDT"),
    interval: z.string().describe("Timeframe: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 1w, 1M"),
    limit: z.number().optional().describe("Number of bars (max 1440, default 100)"),
  },
  async ({ symbol, interval, limit = 100 }) => {
    try {
      const data = await bingxGet("/openApi/swap/v3/quote/klines", { symbol, interval, limit });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_balance",
  "Get demo account balance and available margin",
  {},
  async () => {
    try {
      const data = await bingxGet("/openApi/swap/v2/user/balance");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_positions",
  "Get all open perpetual futures positions on the demo account",
  { symbol: z.string().optional().describe("Filter by symbol, e.g. BTC-USDT (omit for all)") },
  async ({ symbol }) => {
    try {
      const params = symbol ? { symbol } : {};
      const data = await bingxGet("/openApi/swap/v2/user/positions", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_open_orders",
  "Get all open (pending) orders",
  { symbol: z.string().describe("Symbol, e.g. BTC-USDT") },
  async ({ symbol }) => {
    try {
      const data = await bingxGet("/openApi/swap/v2/trade/openOrders", { symbol });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "place_order",
  "Place a perpetual futures order on BingX demo account",
  {
    symbol: z.string().describe("Symbol, e.g. BTC-USDT"),
    side: z.enum(["BUY", "SELL"]).describe("Order direction"),
    positionSide: z.enum(["LONG", "SHORT", "BOTH"]).describe("Position side: LONG, SHORT, or BOTH"),
    type: z.enum(["MARKET", "LIMIT", "STOP_MARKET", "TAKE_PROFIT_MARKET"]).describe("Order type"),
    quantity: z.number().describe("Contract quantity"),
    price: z.number().optional().describe("Limit price (required for LIMIT orders)"),
    stopPrice: z.number().optional().describe("Trigger price (required for STOP_MARKET/TAKE_PROFIT_MARKET)"),
    leverage: z.number().optional().describe("Leverage multiplier (e.g. 10 for 10x)"),
  },
  async ({ symbol, side, positionSide, type, quantity, price, stopPrice, leverage }) => {
    try {
      if (leverage) {
        await bingxPost("/openApi/swap/v2/trade/leverage", { symbol, side, leverage });
      }
      const params = { symbol, side, positionSide, type, quantity };
      if (price) params.price = price;
      if (stopPrice) params.stopPrice = stopPrice;
      const data = await bingxPost("/openApi/swap/v2/trade/order", params);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}\n${e.response?.data ? JSON.stringify(e.response.data) : ""}` }] };
    }
  }
);

server.tool(
  "cancel_order",
  "Cancel an open order by order ID",
  {
    symbol: z.string().describe("Symbol, e.g. BTC-USDT"),
    orderId: z.string().describe("Order ID to cancel"),
  },
  async ({ symbol, orderId }) => {
    try {
      const data = await bingxDelete("/openApi/swap/v2/trade/order", { symbol, orderId });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "cancel_all_orders",
  "Cancel all open orders for a symbol",
  { symbol: z.string().describe("Symbol, e.g. BTC-USDT") },
  async ({ symbol }) => {
    try {
      const data = await bingxDelete("/openApi/swap/v2/trade/allOpenOrders", { symbol });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "close_position",
  "Close an open position for a symbol (market close)",
  {
    symbol: z.string().describe("Symbol, e.g. BTC-USDT"),
    positionSide: z.enum(["LONG", "SHORT"]).describe("Which side to close"),
  },
  async ({ symbol, positionSide }) => {
    try {
      const posData = await bingxGet("/openApi/swap/v2/user/positions", { symbol });
      const positions = posData?.data || [];
      const pos = positions.find((p) => p.positionSide === positionSide);
      if (!pos || parseFloat(pos.positionAmt) === 0) {
        return { content: [{ type: "text", text: `No open ${positionSide} position found for ${symbol}` }] };
      }
      const qty = Math.abs(parseFloat(pos.positionAmt));
      const closeSide = positionSide === "LONG" ? "SELL" : "BUY";
      const data = await bingxPost("/openApi/swap/v2/trade/order", {
        symbol, side: closeSide, positionSide, type: "MARKET", quantity: qty,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

server.tool(
  "get_rules",
  "Read the current trading rules from rules.json",
  {},
  async () => {
    const rules = loadRules();
    if (!rules) {
      return { content: [{ type: "text", text: "rules.json not found." }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(rules, null, 2) }] };
  }
);

server.tool(
  "check_signals",
  "Scan the rules.json watchlist for MA20 entry signals. Pass execute=true to place orders for triggered signals (default false = dry run).",
  { execute: z.boolean().optional().describe("If true, place orders for triggered signals (default false = dry run)") },
  async ({ execute = false }) => {
    const rules = loadRules();
    if (!rules) return { content: [{ type: "text", text: "rules.json not found." }] };

    const MA_PERIOD   = rules.indicators?.MA20?.length  || 20;
    const TIMEFRAME   = rules.timeframe                  || "1m";
    const LEVERAGE    = rules.position_sizing?.leverage  || 5;
    const RISK_PCT    = rules.position_sizing?.risk_pct  || 0.01;
    const MAX_MARGIN  = rules.position_sizing?.max_margin || 500;
    const MIN_BODY    = 0.0002;
    const blacklist   = new Set(rules.blacklist || []);
    const watchlist   = (rules.watchlist || []).filter(s => !blacklist.has(s));

    function sma(closes, period) {
      if (closes.length < period) return null;
      const sl = closes.slice(-period);
      return sl.reduce((a, b) => a + b, 0) / period;
    }

    function checkEntry(candles) {
      if (candles.length < MA_PERIOD + 2) return null;
      const curr   = candles[candles.length - 1];
      const prev   = candles[candles.length - 2];
      const closes = candles.map(c => c.close);
      const currMA = sma(closes, MA_PERIOD);
      if (!currMA) return null;
      const bodyPct = Math.abs(curr.close - curr.open) / curr.open;
      if (bodyPct < MIN_BODY) return null;
      if (curr.close > curr.open && prev.close < prev.open && curr.close >= currMA) return "LONG";
      if (curr.close < curr.open && prev.close > prev.open && curr.close <= currMA) return "SHORT";
      return null;
    }

    const results = [];
    let triggered = 0;

    for (const sym of watchlist) {
      try {
        const d = await bingxGet("/openApi/swap/v3/quote/klines", { symbol: sym, interval: TIMEFRAME, limit: MA_PERIOD + 3 });
        if (!Array.isArray(d?.data)) { results.push(`[SKIP] ${sym} — no candle data`); continue; }
        const candles = d.data.map(c => ({ open: parseFloat(c.open), close: parseFloat(c.close) }));
        const sig = checkEntry(candles);
        if (!sig) { results.push(`[NO SIGNAL] ${sym}`); continue; }

        const currPrice = candles[candles.length - 1].close;
        triggered++;
        results.push(`[SIGNAL] ${sig.padEnd(5)} ${sym} @ ${currPrice}`);

        if (execute) {
          const margin   = Math.min(0 * RISK_PCT, MAX_MARGIN); // balance unknown in dry-run context
          const side         = sig === "LONG" ? "BUY" : "SELL";
          const positionSide = sig;
          try { await bingxPost("/openApi/swap/v2/trade/leverage", { symbol: sym, side, leverage: LEVERAGE }); } catch {}
          const priceData = await bingxGet("/openApi/swap/v2/quote/price", { symbol: sym });
          const price     = parseFloat(priceData?.data?.price || currPrice);
          const balData   = await bingxGet("/openApi/swap/v2/user/balance");
          const bal       = parseFloat(balData?.data?.balance?.availableMargin || 0);
          const qty       = Math.floor((Math.min(bal * RISK_PCT, MAX_MARGIN) * LEVERAGE / price) * 10) / 10;
          if (qty > 0) {
            const order = await bingxPost("/openApi/swap/v2/trade/order", { symbol: sym, side, positionSide, type: "MARKET", quantity: qty });
            results.push(`  -> Order: ${JSON.stringify(order?.data || order)}`);
          } else {
            results.push(`  -> Skipped: qty=0`);
          }
        }
      } catch (e) {
        results.push(`[ERROR] ${sym}: ${e.message}`);
      }
    }

    results.unshift(`MA${MA_PERIOD} Signal Scan — ${watchlist.length} symbols | ${triggered} signal(s) | execute=${execute}`);
    return { content: [{ type: "text", text: results.join("\n") }] };
  }
);

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
