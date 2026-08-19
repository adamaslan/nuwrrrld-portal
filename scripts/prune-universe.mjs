#!/usr/bin/env node
/**
 * prune-universe — deactivate tickers the hydration lane can never card.
 *
 * Every symbol in `ticker_universe` is walked by every hydration run. A symbol
 * Alpaca will not serve is not a transient miss: it fails today, tomorrow, and
 * every night after, consuming a slot in a chunk and a line in the error log
 * forever. Deactivating it is the difference between a run that reports real
 * coverage and one whose failure count is permanently floored above zero.
 *
 * Classification is by *evidence from the vendor*, not by name or guesswork.
 * Each candidate is probed over a two-year window and sorted into:
 *
 *   young   — bars within RECENT_DAYS but fewer than MIN_BARS. Newly listed.
 *             KEPT: it cards itself once history builds, and pruning it would
 *             silently drop a real, currently-trading symbol.
 *   retry   — bars within RECENT_DAYS and at least MIN_BARS, yet still no
 *             card. KEPT, and reported loudly: hydration *failed* for these
 *             rather than declining to run, so they will not self-heal. This
 *             is the shape 12 symbols were left in after the whole-chunk-400
 *             bug was fixed but the symbols it had cost were never re-run.
 *   stale   — real history that stops. Acquired, delisted, renamed.
 *   never   — zero bars in two years. OTC ADRs and mutual funds Alpaca has
 *             never covered (TCEHY, SFTBY, VTSAX).
 *   reject  — Alpaca 400s the symbol outright: crypto pairs against a stocks
 *             endpoint, preferred-share notation.
 *
 * Only the last three are deactivated. `active = false` is reversible and
 * preserves the row, its cards, and its history — this never DELETEs.
 *
 * Liveness and sufficiency are deliberately separate questions: recency says
 * whether a symbol still trades, bar count says what a live one needs. Folding
 * them together is how a newly-listed ticker gets pruned for being new.
 *
 * Usage:
 *   node scripts/prune-universe.mjs --dry-run     # classify, change nothing
 *   node scripts/prune-universe.mjs               # deactivate stale/never/reject
 *
 * Env: DATABASE_URL, ALPACA_API_KEY, ALPACA_API_SECRET.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

/** Read a key from .env.local so the script runs the same way hydrate-local does. */
function fromEnvFile(key) {
  try {
    const text = readFileSync(join(repoRoot, ".env.local"), "utf8");
    const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  } catch {
    return null;
  }
}

const DATABASE_URL = process.env.DATABASE_URL ?? fromEnvFile("DATABASE_URL");
const ALPACA_API_KEY = process.env.ALPACA_API_KEY ?? fromEnvFile("ALPACA_API_KEY");
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET ?? fromEnvFile("ALPACA_API_SECRET");

if (!DATABASE_URL) fail("DATABASE_URL is not set");
if (!ALPACA_API_KEY || !ALPACA_API_SECRET) fail("ALPACA_API_KEY / ALPACA_API_SECRET are not set");

/** Bars a symbol needs before hydrate-local will card it — must match
 *  MIN_BARS there, or this script prunes symbols that would have worked. */
const MIN_BARS = 40;
/** A symbol trading this recently is live, however little history it has. */
const RECENT_DAYS = 14;
const LOOKBACK_YEARS = 2;
const CHUNK_SIZE = 10;

const sql = neon(DATABASE_URL);

function fail(message) {
  process.stderr.write(`prune-universe: ${message}\n`);
  process.exit(1);
}

/** Bars for a chunk, dropping symbols Alpaca rejects by name — the same
 *  whole-chunk-400 hazard hydrate-local's fetchBars works around. */
async function fetchBars(symbols, startIso) {
  let remaining = [...symbols];
  const rejected = [];
  while (remaining.length > 0) {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", remaining.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", startIso);
    url.searchParams.set("limit", "10000");
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
      },
    });
    if (res.ok) return { bars: (await res.json()).bars ?? {}, rejected };
    const body = await res.text();
    const bad = /invalid symbol:\s*([^"'}\s]+)/i.exec(body)?.[1];
    if (!bad || !remaining.includes(bad)) {
      throw new Error(`Alpaca ${res.status}: ${body.slice(0, 200)}`);
    }
    rejected.push(bad);
    remaining = remaining.filter((s) => s !== bad);
  }
  return { bars: {}, rejected };
}

async function main() {
  const rows = await sql`
    SELECT u.ticker FROM ticker_universe u
     WHERE u.active
       AND NOT EXISTS (SELECT 1 FROM ticker_cards c WHERE c.ticker = u.ticker)
     ORDER BY u.ticker
  `;
  const candidates = rows.map((r) => r.ticker);
  if (candidates.length === 0) {
    process.stdout.write("Every active ticker has a card — nothing to prune.\n");
    return;
  }

  const start = new Date();
  start.setFullYear(start.getFullYear() - LOOKBACK_YEARS);
  const startIso = start.toISOString().split("T")[0];
  const recentCutoff = new Date(Date.now() - RECENT_DAYS * 86_400_000)
    .toISOString()
    .split("T")[0];

  process.stdout.write(
    `Probing ${candidates.length} carded-less ticker(s) over ${LOOKBACK_YEARS}y ` +
      `(live cutoff ${recentCutoff})\n`,
  );

  const groups = { young: [], retry: [], stale: [], never: [], reject: [] };
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE);
    const { bars, rejected } = await fetchBars(chunk, startIso);
    groups.reject.push(...rejected);
    for (const sym of chunk) {
      if (rejected.includes(sym)) continue;
      const series = bars[sym] ?? [];
      if (series.length === 0) {
        groups.never.push(sym);
        continue;
      }
      const last = String(series.at(-1).t).slice(0, 10);
      // Recency decides whether a symbol is alive, not volume: one listed last
      // week has few bars and is perfectly alive, while one with 400 bars
      // ending in April is not. Bar count then decides what a *live* symbol
      // needs — those two questions are separate, and conflating them is how a
      // tradeable ticker gets pruned for being new.
      if (last < recentCutoff) {
        groups.stale.push(`${sym}(last ${last})`);
      } else if (series.length < MIN_BARS) {
        groups.young.push(`${sym}(${series.length} bars, last ${last})`);
      } else {
        groups.retry.push(`${sym}(${series.length} bars, last ${last})`);
      }
    }
  }

  for (const key of ["young", "retry", "stale", "never", "reject"]) {
    process.stdout.write(`\n${key.toUpperCase()} (${groups[key].length})\n`);
    if (groups[key].length) process.stdout.write(`  ${groups[key].join(" ")}\n`);
  }

  if (groups.young.length) {
    process.stdout.write(
      `\nKeeping ${groups.young.length} young symbol(s): trading within ${RECENT_DAYS} days ` +
        `but under the ${MIN_BARS}-bar minimum. They card themselves once history builds.\n`,
    );
  }
  if (groups.retry.length) {
    // These are the interesting ones: current, sufficiently deep, and still
    // cardless — so hydration failed for them rather than declining to run.
    // Reporting them as self-carding would be wrong; they need a retry, and
    // exactly this shape is how 12 symbols sat uncarded after the whole-chunk
    // 400 bug was fixed but never re-run.
    process.stdout.write(
      `\nKeeping ${groups.retry.length} symbol(s) that are current AND have >= ${MIN_BARS} bars ` +
        `but still no card — these will NOT self-heal. Re-run hydration for them:\n` +
        `  node scripts/hydrate-local.mjs --symbols=${groups.retry.map((s) => s.split("(")[0]).join(",")}\n`,
    );
  }

  const toPrune = [
    ...groups.stale.map((s) => s.split("(")[0]),
    ...groups.never,
    ...groups.reject,
  ];
  if (toPrune.length === 0) {
    process.stdout.write("\nNothing to deactivate.\n");
    return;
  }

  if (DRY_RUN) {
    process.stdout.write(`\n(dry run — would deactivate ${toPrune.length} ticker(s))\n`);
    return;
  }

  // Re-assert the candidate condition inside the UPDATE, not just in the
  // SELECT that chose these. Probing 49 symbols against a vendor takes tens of
  // seconds, and a hydration run finishing in that window would card one of
  // them — deactivating a ticker that had just proven it works is the one
  // outcome this script must never produce. Cheap to guard, and the guard is
  // the same predicate the candidate query used.
  const updated = await sql`
    UPDATE ticker_universe u SET active = false
     WHERE u.ticker = ANY(${toPrune})
       AND u.active = true
       AND NOT EXISTS (SELECT 1 FROM ticker_cards c WHERE c.ticker = u.ticker)
     RETURNING u.ticker
  `;
  const skipped = toPrune.length - updated.length;
  if (skipped > 0) {
    process.stdout.write(
      `\n${skipped} candidate(s) were carded or already inactive since the probe — left active.\n`,
    );
  }
  process.stdout.write(`\nDeactivated ${updated.length} ticker(s). Rows and cards preserved;\n`);
  process.stdout.write(`re-enable with: UPDATE ticker_universe SET active = true WHERE ticker = '<T>';\n`);
}

main().catch((err) => {
  process.stderr.write(`prune-universe failed: ${err.message}\n`);
  process.exit(1);
});
