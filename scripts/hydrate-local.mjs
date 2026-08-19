#!/usr/bin/env node
/**
 * hydrate-local — run universe hydration against a portal, local or deployed.
 *
 * Same indicator math as deploy/universe-hydration/modal_app.py, but in JS.
 * Written to hit a local dev server so you can watch every chunk land and
 * inspect the cards; it is also what `.github/workflows/hydrate-universe.yml`
 * runs unattended, since `process.env` takes precedence over `.env.local` and
 * the file's absence is not an error. The name is kept for the git history and
 * the wiki references that point at it — "local" describes where it was first
 * used, not where it can run.
 *
 * With no --universe, both lanes run: every active stock, then every active
 * ETF, each labeled correctly on the way in. The label matters — it is what
 * keeps a 3x inverse ETF from being ranked as a BUY beside an equity.
 *
 * Usage:
 *   node scripts/hydrate-local.mjs                            # stocks, then ETFs
 *   node scripts/hydrate-local.mjs --symbols=AAPL,MSFT,NVDA
 *   node scripts/hydrate-local.mjs --universe=etf             # ETFs only
 *   node scripts/hydrate-local.mjs --limit=50                 # first 50 per lane
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

// Restricts the run to one lane. Omitted means both, in order. Validated
// against the same two values `CardUniverse` allows, so a typo can't silently
// hydrate nothing (a bad ?universe= is ignored server-side and returns all).
const universeFlag = process.argv.find(a => a.startsWith("--universe="));
let UNIVERSE = null;
if (universeFlag) {
  const raw = universeFlag.slice("--universe=".length).trim().toLowerCase();
  if (raw !== "stock" && raw !== "etf") {
    fail("--universe must be 'stock' or 'etf'");
  }
  UNIVERSE = raw;
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

/** One Alpaca /v2/stocks/bars call. Throws on any non-2xx. */
async function fetchBarsOnce(symbols) {
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
 * Bars for a chunk, where one unusable symbol costs only itself.
 *
 * Alpaca rejects the whole request with a 400 "invalid symbol: X" if any one
 * symbol is not a US equity — a crypto pair like BTC-USD does that, and the
 * chunked caller then loses all ten symbols it asked about. That is how a
 * 178-symbol ETF run lost 40 rows to 4 bad tickers. On a 400 naming a symbol,
 * drop that symbol and retry the remainder; anything else (auth, rate limit,
 * network) still throws, because those are not per-symbol problems and
 * retrying them one-by-one would just multiply the failure.
 */
async function fetchBars(symbols) {
  let remaining = [...symbols];
  const dropped = [];

  // Bounded by construction: each pass removes at least one symbol.
  while (remaining.length > 0) {
    try {
      const bars = await fetchBarsOnce(remaining);
      if (dropped.length) {
        console.log(`  (skipped ${dropped.length} unusable: ${dropped.join(", ")})`);
      }
      return bars;
    } catch (e) {
      const bad = /invalid symbol:\s*([^"'}\s]+)/i.exec(e.message)?.[1];
      if (!bad || !remaining.includes(bad)) throw e;
      dropped.push(bad);
      remaining = remaining.filter(s => s !== bad);
    }
  }

  console.log(`  (skipped ${dropped.length} unusable: ${dropped.join(", ")})`);
  return {};
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

/**
 * POST one chunk of computed rows to the portal's ingest route.
 *
 * `universe` labels the whole batch — it is a body field, not per row — so the
 * caller must send stocks and ETFs as separate chunks. Returns the portal's own
 * counters rather than the count we sent: a row can be legitimately `skipped`
 * when the stored card is already better (see `shouldReplaceCard`), and
 * reporting that as written would overstate coverage.
 */
async function postChunk(rows, runId, barDate, universe) {
  if (DRY_RUN) {
    console.log(`[dry-run] would POST ${rows.length} rows (universe=${universe})`);
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
      universe,
      barDate,
      rows,
    }),
  });

  if (!res.ok) throw new Error(`Portal returned ${res.status}`);
  return await res.json();
}

/**
 * Active tickers for one universe. Returned per-universe rather than as one
 * flat list because `universe` is a POST-body field covering the whole batch:
 * a chunk mixing stocks and ETFs would have to label one of them wrong, which
 * is how every card ended up marked 'stock' — leveraged inverse ETFs included.
 */
async function getUniverse(universe) {
  const res = await fetch(
    `${PORTAL_URL}/api/pipeline/hydrate-universe?universe=${universe}`,
    {
      headers: { "Authorization": `Bearer ${PORTAL_PUSH_SECRET}` },
    }
  );
  if (!res.ok) throw new Error(`Failed to fetch universe: ${res.status}`);
  return (await res.json()).tickers || [];
}

async function main() {
  // Each lane carries its own `universe` label all the way to the POST body,
  // so an ETF's card is stored as an ETF. --symbols= is treated as stocks
  // unless --universe= says otherwise: the flag is for spot-checking, and
  // guessing a mixed list's membership per-symbol would need a DB round trip.
  const lanes = [];
  if (SYMBOLS) {
    lanes.push({ universe: UNIVERSE ?? "stock", targets: SYMBOLS });
  } else {
    for (const universe of UNIVERSE ? [UNIVERSE] : ["stock", "etf"]) {
      const tickers = await getUniverse(universe);
      lanes.push({ universe, targets: LIMIT ? tickers.slice(0, LIMIT) : tickers });
    }
  }

  const total = lanes.reduce((n, lane) => n + lane.targets.length, 0);
  if (!total) {
    console.error("No targets to hydrate");
    process.exit(1);
  }

  const barDate = new Date().toISOString().split("T")[0];
  const runId = `hydrate-local:${barDate}:${new Date().getTime()}`;

  const laneSummary = lanes.map(l => `${l.universe}=${l.targets.length}`).join(" ");
  console.log(`[hydrate] run=${runId} ${laneSummary} chunk=${CHUNK_SIZE}`);

  // Three counters, deliberately distinct: rows the portal confirmed it wrote,
  // rows that failed to *compute* locally, and rows lost to a failed POST.
  // Collapsing these made a fully-failed chunk report written=10 failed=10.
  let written = 0,
    calcErrors = 0,
    postFailures = 0;

  for (const { universe, targets } of lanes) {
    if (!targets.length) continue;
    console.log(`\n=== ${universe} (${targets.length} symbols) ===`);

    for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
      const chunk = targets.slice(i, i + CHUNK_SIZE);
      console.log(`\n[${universe} ${i + 1}–${Math.min(i + CHUNK_SIZE, targets.length)}]`);

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
        const result = await postChunk(rows, runId, barDate, universe);
        written += result.written ?? 0;
        postFailures += result.failed ?? 0;
        console.log(`  → posted: written=${result.written} failed=${result.failed}`);
      } catch (e) {
        console.error(`  ERROR: ${e.message}`);
        postFailures += chunk.length;
      }
    }
  }

  console.log(
    `\n[done] written=${written} calc-errors=${calcErrors} ` +
      `post-failures=${postFailures} total=${total}`
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
