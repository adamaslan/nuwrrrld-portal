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
import {
  ALPACA_ADJUSTMENT,
  ALPACA_FEED,
  ALPACA_PAGE_LIMIT,
  CHUNK_SIZE,
  LOOKBACK_DAYS,
  MIN_BARS,
} from "../lib/shared/hydration-constants.mjs";

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

// A non-HTTPS PORTAL_URL sends PORTAL_PUSH_SECRET in cleartext — acceptable
// only on loopback (local dev), never over a real network hop. CodeRabbit
// review, PR #101.
function assertSafePortalUrl(url) {
  const { protocol, hostname } = new URL(url);
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (protocol !== "https:" && !isLoopback) {
    throw new Error(
      `PORTAL_URL (${url}) is not HTTPS and not loopback — refusing to send PORTAL_PUSH_SECRET in cleartext.`,
    );
  }
}

const PORTAL_URL = (process.env.PORTAL_URL ?? env.PORTAL_URL ?? "http://localhost:3000").replace(/\/$/, "");
assertSafePortalUrl(PORTAL_URL);
const PORTAL_PUSH_SECRET = process.env.PORTAL_PUSH_SECRET ?? env.PORTAL_PUSH_SECRET;
const ALPACA_API_KEY = process.env.ALPACA_API_KEY ?? env.ALPACA_API_KEY;
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET ?? env.ALPACA_API_SECRET;
// Per-request cap on a single Alpaca page fetch. Not in hydration-constants.json:
// that file is the single source shared across compute hosts for values that
// affect the *data* (chunk size, lookback window); this is transport-only and
// has no mobile/cross-repo relevance (mobile has no hydration lane at all).
const ALPACA_REQUEST_TIMEOUT_MS = 15_000;

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

// CHUNK_SIZE, LOOKBACK_DAYS and MIN_BARS now come from the one shared source
// (lib/shared/hydration-constants.json) so this lane and Modal cannot drift —
// Phase 2.2 of docs/signal-engine-three-phase-plan.md.
//
// MIN_BARS is the longest lookback any indicator needs before it returns a real
// number: macdCross wants slow + signal = 35 bars, volatilityPercentile wants
// window * 2 = 40, adx wants period * 2 = 28, rsi wants 15. A row is only "ok"
// once every one of them can be computed — see rowFor().

// The count reported by the most recent fetchBars() call: how many vendor
// pages it walked. Surfaced per chunk so a short page is visible in the log
// rather than inferred from a missing symbol three steps later.
let lastFetchPageCount = 0;

// ── vendor fetch ──────────────────────────────────────────────────────────

/**
 * All bars for `symbols`, walking Alpaca's `next_page_token` to completion.
 *
 * Alpaca caps a response at ALPACA_PAGE_LIMIT bars and paginates **sorted by
 * symbol, then timestamp**: an over-cap request returns the leading symbols
 * complete and silently drops the trailing ones. At CHUNK_SIZE symbols over a
 * 365-day lookback one page is expected, but the loop is the correctness
 * guarantee, not the chunk size — this is the port of modal_app.py's
 * pagination loop (Phase 2.1).
 *
 * Pages are merged per symbol in receipt order, which is already
 * timestamp-ascending within a symbol, so `rowFor` still sorts defensively but
 * never has to stitch.
 */
async function fetchBarsOnce(symbols) {
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const startIso = start.toISOString().split("T")[0];

  const merged = {};
  let pageToken = null;
  let pages = 0;

  do {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", startIso);
    url.searchParams.set("limit", String(ALPACA_PAGE_LIMIT));
    url.searchParams.set("feed", ALPACA_FEED);
    url.searchParams.set("adjustment", ALPACA_ADJUSTMENT);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    // Without a per-request timeout, a stalled Alpaca page response hangs
    // this fetch indefinitely — the chunk never reaches the existing
    // per-symbol failure path below, it just wedges the whole run. CodeRabbit
    // review, PR #101.
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
      },
      signal: AbortSignal.timeout(ALPACA_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) throw new Error(`Alpaca returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    pages++;

    for (const [sym, bars] of Object.entries(data.bars || {})) {
      (merged[sym] ??= []).push(...bars);
    }
    pageToken = data.next_page_token || null;
  } while (pageToken);

  lastFetchPageCount = pages;
  return merged;
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
/**
 * Weekdays strictly between an ISO date and today (UTC), i.e. how many trading
 * sessions old the last bar is. A cheap proxy for signals-app's
 * DATA_QUALITY_STALE_HOURS — daily bars only need day granularity — and the
 * input to the staleness deduction in card-policy's real dataQuality (Phase
 * 3.2). Holidays are not netted out; being off by one or two around a holiday
 * week does not change the quality bucket.
 */
function tradingDaysStale(lastBarIso) {
  const last = new Date(`${lastBarIso}T00:00:00Z`);
  const today = new Date(`${new Date().toISOString().split("T")[0]}T00:00:00Z`);
  if (Number.isNaN(last.getTime()) || today <= last) return 0;
  let count = 0;
  const cursor = new Date(last);
  while (cursor < today) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    // Today's session may not have closed yet, so it must never count as a
    // full stale day — without this, a bar from one full weekday behind was
    // counted as 2 instead of 1, applying a premature staleness deduction.
    // CodeRabbit review, PR #101.
    if (cursor >= today) break;
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

/** Bar-series health, independent of which indicators happened to compute:
 *  count, the fraction of OHLC values that are missing/NaN, and how stale the
 *  last bar is. Consumed by the portal's real dataQuality (Phase 3.2); a host
 *  that omits it degrades cleanly to completeness-only scoring. */
function frameStatsFor(sorted) {
  const nums = [];
  for (const b of sorted) nums.push(b.o, b.h, b.l, b.c);
  const bad = nums.filter(v => v == null || Number.isNaN(v) || !Number.isFinite(v)).length;
  const lastIso = String(sorted.at(-1)?.t ?? "").split("T")[0];
  return {
    barCount: sorted.length,
    nanRatio: nums.length ? bad / nums.length : 1,
    staleTradingDays: lastIso ? tradingDaysStale(lastIso) : null,
  };
}

function rowFor(symbol, barData) {
  if (!barData || barData.length < MIN_BARS) {
    return {
      ticker: symbol,
      status: "error",
      error: "insufficient history",
      frameStats: barData ? { barCount: barData.length, nanRatio: 1, staleTradingDays: null } : undefined,
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
      frameStats: frameStatsFor(sorted),
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

    const chunkCount = Math.ceil(targets.length / CHUNK_SIZE);
    for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
      const chunk = targets.slice(i, i + CHUNK_SIZE);
      console.log(`\n[${universe} ${i + 1}–${Math.min(i + CHUNK_SIZE, targets.length)}]`);

      try {
        const barsBySymbol = await fetchBars(chunk);
        const rows = chunk.map(sym => rowFor(sym, barsBySymbol[sym]));

        // Phase 2.1 observability: a chunk that comes back short — fewer symbols
        // than asked for, or more than one page — is the observable form of
        // every vendor problem in the parity doc, so it gets its own line.
        const symbolsWithBars = chunk.filter(
          s => Array.isArray(barsBySymbol[s]) && barsBySymbol[s].length > 0,
        ).length;
        const barsTotal = chunk.reduce(
          (n, s) => n + (barsBySymbol[s]?.length ?? 0), 0,
        );
        console.log(
          `  [hydrate] chunk ${i / CHUNK_SIZE + 1}/${chunkCount}  ` +
            `pages=${lastFetchPageCount}  symbols=${symbolsWithBars}/${chunk.length}  ` +
            `bars=${barsTotal.toLocaleString()}`,
        );
        if (lastFetchPageCount > 1) {
          // fetchBarsOnce walks next_page_token to completion — a multi-page
          // response is fully handled, not truncated. Reporting it as a
          // truncation risk was accurate before pagination existed but is now
          // a false data-loss alert that advises an unnecessary CHUNK_SIZE
          // reduction. The real truncation signal is the symbolsWithBars
          // check below. CodeRabbit review, PR #101.
          console.log(
            `  [hydrate] chunk needed ${lastFetchPageCount} pages (over the ` +
              `${ALPACA_PAGE_LIMIT}-bar cap) — pagination completed normally`,
          );
        }
        if (symbolsWithBars < chunk.length) {
          console.warn(
            `  ::warning:: ${chunk.length - symbolsWithBars} symbol(s) in this ` +
              `chunk returned no bars`,
          );
        }

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
