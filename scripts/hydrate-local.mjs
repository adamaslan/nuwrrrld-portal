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

import {
  adx,
  confluence,
  macdCross,
  rsi,
  volatilityPercentile,
} from "./lib/hydrate-indicators.mjs";

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

function fail(message) {
  console.error(`hydrate-local: ${message}`);
  process.exit(1);
}

// ── argument parsing ──────────────────────────────────────────────────────
// Both options are validated up front. An unparseable value must abort rather
// than fall through to "hydrate the entire universe", which is the expensive
// default and never what a malformed flag meant to ask for.
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");

const symbolsFlag = process.argv.find(a => a.startsWith("--symbols="));
let SYMBOLS = null;
if (symbolsFlag) {
  const raw = symbolsFlag.slice("--symbols=".length);
  SYMBOLS = raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!SYMBOLS.length || SYMBOLS.length !== raw.split(",").length) {
    fail("--symbols must be a comma-separated list of non-empty ticker symbols");
  }
}

const limitFlag = process.argv.find(a => a.startsWith("--limit="));
let LIMIT = null;
if (limitFlag) {
  const raw = limitFlag.slice("--limit=".length);
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    fail("--limit must be a positive integer");
  }
  LIMIT = Number(raw);
}

// ── guards ────────────────────────────────────────────────────────────────
if (!PORTAL_PUSH_SECRET) throw new Error("PORTAL_PUSH_SECRET is not set");
if (!ALPACA_API_KEY) throw new Error("ALPACA_API_KEY is not set");
if (!ALPACA_API_SECRET) throw new Error("ALPACA_API_SECRET is not set");

const CHUNK_SIZE = 10;
const LOOKBACK_DAYS = 120;

// Longest lookback any indicator needs before it returns a real number:
// macdCross wants slow + signal = 35 bars, volatilityPercentile wants
// window * 2 = 40, adx wants period * 2 = 28, rsi wants 15. A row is only
// "ok" once every one of them can be computed — see rowFor().
const MIN_BARS = 40;

// ── vendor fetch ──────────────────────────────────────────────────────────
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

/**
 * Compute one symbol's indicator row. Never throws — an indicator failure
 * becomes a per-row error so one bad symbol cannot poison the whole run.
 *
 * Mirrors _row_for() in modal_app.py, including the macdCross key convention:
 * an omitted key means "not computed", an explicit null means "computed, no
 * cross". Those are different facts and must not collapse into one.
 */
function rowFor(symbol, barData) {
  if (!barData || barData.length < MIN_BARS) {
    return {
      ticker: symbol,
      status: "error",
      error: "insufficient history",
    };
  }

  try {
    const sorted = [...barData].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const close = sorted.map(b => b.c);
    const high = sorted.map(b => b.h);
    const low = sorted.map(b => b.l);

    const rsiVal = rsi(close);
    const macdVal = macdCross(close);
    const adxVal = adx(high, low, close);
    const volVal = volatilityPercentile(close);
    const { score, direction } = confluence(
      rsiVal,
      macdVal === "missing" ? undefined : macdVal,
      adxVal
    );

    const row = {
      ticker: symbol,
      status: "ok",
      rsi: rsiVal,
      adx: adxVal,
      volatilityPercentile: volVal,
      confluenceScore: score,
      direction,
    };
    if (macdVal !== "missing") row.macdCross = macdVal;
    return row;
  } catch (e) {
    return {
      ticker: symbol,
      status: "error",
      error: `${e.name}: ${e.message}`,
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

  if (SYMBOLS) {
    targets = SYMBOLS;
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

  // Three counters, deliberately distinct: rows the portal confirmed it wrote,
  // rows that failed to *compute* locally, and rows lost to a failed POST.
  // Collapsing these made a fully-failed chunk report written=10 failed=10.
  let written = 0,
    calcErrors = 0,
    postFailures = 0;

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);
    console.log(`\n[${i + 1}–${Math.min(i + CHUNK_SIZE, targets.length)}]`);

    try {
      const barsBySymbol = await fetchBars(chunk);
      const rows = chunk.map(sym => rowFor(sym, barsBySymbol[sym]));

      for (const row of rows) {
        if (row.status === "ok") {
          console.log(
            `  ${row.ticker}: score=${row.confluenceScore} direction=${row.direction}`
          );
        } else {
          console.log(`  ${row.ticker}: ERROR ${row.error}`);
          calcErrors++;
        }
      }

      // Persistence counters come from the portal's response, and only after
      // it has actually answered — never from the count we optimistically sent.
      const result = await postChunk(rows, runId, barDate);
      written += result.written ?? 0;
      postFailures += result.failed ?? 0;
      console.log(`  → posted: written=${result.written} failed=${result.failed}`);
    } catch (e) {
      console.error(`  ERROR: ${e.message}`);
      postFailures += chunk.length;
    }
  }

  console.log(
    `\n[done] written=${written} calc-errors=${calcErrors} ` +
      `post-failures=${postFailures} total=${targets.length}`
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
