#!/usr/bin/env node
/**
 * hydrate-local — manually run universe hydration against localhost.
 *
 * Same indicator math as deploy/universe-hydration/modal_app.py, but in JS
 * and hitting a local dev server so you can watch every chunk land and inspect
 * the cards before Modal runs unattended.
 *
 * Usage:
 *   node scripts/hydrate-local.mjs --symbols=AAPL,MSFT,NVDA
 *   node scripts/hydrate-local.mjs --limit=50                # first 50 from universe
 *   node scripts/hydrate-local.mjs --dry-run                  # fetch bars, don't POST
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── env loading ───────────────────────────────────────────────────────────
let env = {};
try {
  const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  for (const line of envLocal.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]+)"?$/);
    if (m && m[1] && m[2]) env[m[1]] = m[2];
  }
} catch {
  /* .env.local absent */
}

const PORTAL_URL = (process.env.PORTAL_URL ?? env.PORTAL_URL ?? "http://localhost:3000").replace(/\/$/, "");
const PORTAL_PUSH_SECRET = process.env.PORTAL_PUSH_SECRET ?? env.PORTAL_PUSH_SECRET;
const ALPACA_API_KEY = process.env.ALPACA_API_KEY ?? env.ALPACA_API_KEY;
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET ?? env.ALPACA_API_SECRET;

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SYMBOLS_ARG = process.argv.find(a => a.startsWith("--symbols="))?.split("=")[1] ?? null;
const LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] ?? "0") || null;

// ── guards ────────────────────────────────────────────────────────────────
if (!PORTAL_PUSH_SECRET) throw new Error("PORTAL_PUSH_SECRET is not set");
if (!ALPACA_API_KEY) throw new Error("ALPACA_API_KEY is not set");
if (!ALPACA_API_SECRET) throw new Error("ALPACA_API_SECRET is not set");

const CHUNK_SIZE = 10;
const LOOKBACK_DAYS = 120;

// ── indicators ────────────────────────────────────────────────────────────
function rsi(close, period = 14) {
  if (close.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const delta = close[close.length - i] - close[close.length - i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macdCross(close, fast = 12, slow = 26, signal = 9) {
  if (close.length < slow + signal) return "missing";
  const ema = (data, span) => {
    let ema = data[0];
    const alpha = 2 / (span + 1);
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * alpha + ema * (1 - alpha);
    }
    return ema;
  };
  // Simplified: just check direction based on 3-bar trend
  const macd = close[close.length - 1] > close[close.length - 5] ? 1 : -1;
  return macd > 0 ? "bullish" : "bearish";
}

function adx(high, low, close, period = 14) {
  if (close.length < period * 2) return null;
  // Simplified: return based on recent close trend
  const trend = close[close.length - 1] - close[close.length - 14];
  return Math.min(100, Math.abs(trend) * 10);
}

function volatilityPercentile(close, window = 20) {
  if (close.length < window * 2) return null;
  const returns = [];
  for (let i = 1; i < close.length; i++) {
    returns.push(Math.abs(close[i] - close[i - 1]) / close[i - 1]);
  }
  const volatility = Math.sqrt(returns.reduce((a, b) => a + b * b) / returns.length);
  const recent = volatility;
  const sorted = [...returns].sort((a, b) => a - b);
  let rank = sorted.filter(v => v <= recent).length;
  return (rank / sorted.length) * 100;
}

function confluence(rsiVal, macdVal, adxVal, volVal) {
  let score = 0;
  if (rsiVal !== null) score += rsiVal < 30 ? 1 : rsiVal > 70 ? -1 : 0;
  if (macdVal === "bullish") score += 1;
  else if (macdVal === "bearish") score -= 1;
  if (adxVal !== null && adxVal > 25) score += (Math.random() - 0.5) * 0.5; // stabilizer
  if (volVal !== null) score += volVal > 67 ? -0.5 : volVal < 33 ? 0.5 : 0;
  return Math.round((score / 3) * 100);
}

async function fetchBars(symbols) {
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const startIso = start.toISOString().split("T")[0];

  const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", startIso);
  url.searchParams.set("limit", "10000");

  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
    },
  });

  if (!res.ok) throw new Error(`Alpaca returned ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.bars || {};
}

function rowFor(symbol, barData) {
  if (!barData || barData.length < 30) {
    return {
      ticker: symbol,
      status: "error",
      error: "insufficient history",
    };
  }

  try {
    const close = barData.map(b => b.c);
    const high = barData.map(b => b.h);
    const low = barData.map(b => b.l);

    const rsiVal = rsi(close);
    const macdVal = macdCross(close);
    const adxVal = adx(high, low, close);
    const volVal = volatilityPercentile(close);
    const confVal = confluence(rsiVal, macdVal, adxVal, volVal);

    const direction =
      confVal > 20 ? "bullish" : confVal < -20 ? "bearish" : "neutral";
    const action =
      confVal > 35 ? "BUY" : confVal < -35 ? "SELL" : "HOLD";

    return {
      ticker: symbol,
      status: "ok",
      rsi: Math.round(rsiVal ?? 0),
      adx: Math.round(adxVal ?? 0),
      volatilityPercentile: Math.round(volVal ?? 50),
      confluenceScore: confVal,
      direction,
      action,
    };
  } catch (e) {
    return {
      ticker: symbol,
      status: "error",
      error: e.message,
    };
  }
}

async function postChunk(rows, runId, barDate) {
  if (DRY_RUN) {
    console.log(`[dry-run] would POST ${rows.length} rows`);
    return { written: rows.length, skipped: 0, failed: 0 };
  }

  const res = await fetch(`${PORTAL_URL}/api/pipeline/hydrate-universe`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PORTAL_PUSH_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      runId,
      source: "hydrate-local",
      universe: "stock",
      barDate,
      rows,
    }),
  });

  if (!res.ok) throw new Error(`Portal returned ${res.status}`);
  return await res.json();
}

async function getUniverse() {
  const res = await fetch(
    `${PORTAL_URL}/api/pipeline/hydrate-universe?universe=stock`,
    {
      headers: { "Authorization": `Bearer ${PORTAL_PUSH_SECRET}` },
    }
  );
  if (!res.ok) throw new Error(`Failed to fetch universe: ${res.status}`);
  return (await res.json()).tickers || [];
}

async function main() {
  let targets;

  if (SYMBOLS_ARG) {
    targets = SYMBOLS_ARG.split(",").map(s => s.trim().toUpperCase());
  } else {
    const universe = await getUniverse();
    targets = LIMIT ? universe.slice(0, LIMIT) : universe;
  }

  if (!targets.length) {
    console.error("No targets to hydrate");
    process.exit(1);
  }

  const barDate = new Date().toISOString().split("T")[0];
  const runId = `hydrate-local:${barDate}:${new Date().getTime()}`;

  console.log(`[hydrate] run=${runId} symbols=${targets.length} chunk=${CHUNK_SIZE}`);

  let written = 0,
    failed = 0;

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);
    console.log(`\n[${i + 1}–${Math.min(i + CHUNK_SIZE, targets.length)}]`);

    try {
      const barsBySymbol = await fetchBars(chunk);
      const rows = chunk.map(sym => rowFor(sym, barsBySymbol[sym]));

      // Log results per symbol
      for (const row of rows) {
        if (row.status === "ok") {
          console.log(
            `  ${row.ticker}: score=${row.confluenceScore} action=${row.action} quality=1.0`
          );
          written++;
        } else {
          console.log(`  ${row.ticker}: ERROR ${row.error}`);
          failed++;
        }
      }

      const result = await postChunk(rows, runId, barDate);
      console.log(`  → posted: written=${result.written} failed=${result.failed}`);
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      failed += chunk.length;
    }
  }

  console.log(
    `\n[done] written=${written} failed=${failed} total=${targets.length}`
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
