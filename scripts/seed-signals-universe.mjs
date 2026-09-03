#!/usr/bin/env node
/**
 * seed-signals-universe — register the signals-app universe (~954 tickers)
 * into `ticker_universe`.
 *
 * Companion to seed-universe.mjs, which scrapes S&P 500 + Nasdaq-100 from
 * Wikipedia (~518 distinct). This one reads the curated CSV that
 * ~/code/signals-app already maintains at seed/universe_symbols.csv, which is
 * both larger and richer: it carries an `asset_type` column, so ETFs are
 * registered as `universe='etf'` instead of being mixed into the stock
 * ranking.
 *
 * That distinction is not cosmetic — see `topCards`'s docstring: an inverse or
 * leveraged ETF's price series is the negation of the exposure its name
 * implies, so ranking those beside equities produces a top-100 that is mostly
 * ETFs and recommends a 2x inverse fund as a BUY. The CSV's asset_type is what
 * lets this script get that right at ingest time rather than after the fact.
 *
 * Crypto rows are skipped: the card pipeline's horizons and the trading-day
 * math in followed-tickers-policy assume a Mon–Fri session calendar, which
 * 24/7 crypto violates. Registering them would quietly produce wrong
 * `days_held` on every horizon.
 *
 * Usage:
 *   PORTAL_PUSH_SECRET=... node scripts/seed-signals-universe.mjs
 *   node scripts/seed-signals-universe.mjs --dry-run
 *   node scripts/seed-signals-universe.mjs --csv=/path/to/universe_symbols.csv
 *   node scripts/seed-signals-universe.mjs --only=stock    # or --only=etf
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:3000").replace(/\/$/, "");

// PORTAL_PUSH_SECRET rides in an Authorization header on every registration
// POST, so refuse to send it over cleartext HTTP to anything but loopback.
{
  const u = new URL(PORTAL_URL);
  const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !isLoopback) {
    throw new Error(
      `PORTAL_URL must be https:// for a non-local host (got ${PORTAL_URL}) — ` +
        `refusing to send PORTAL_PUSH_SECRET over cleartext`,
    );
  }
}
const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] ?? null;
const CSV_PATH =
  process.argv.find((a) => a.startsWith("--csv="))?.split("=")[1] ??
  join(homedir(), "code", "signals-app", "seed", "universe_symbols.csv");

// Same guard as seed-universe.mjs: a truncated read or a changed file layout
// should fail loud rather than silently register a handful of rows. Each run
// mode gets its own floor so `--only=stock` can't slip a truncated CSV through
// the way a single shared minimum would.
const MIN_ROWS = 800; // full run (stock + etf)
const MIN_STOCK_ROWS = 600; // --only=stock  (universe carries ~780)
const MIN_ETF_ROWS = 120; // --only=etf    (universe carries ~172)

const TICKER_RE = /^[A-Z][A-Z.\-]{0,9}$/;

/**
 * Parse one CSV line honoring double-quoted fields.
 *
 * Necessary rather than paranoid: the source file's `name` and `sector_group`
 * columns contain commas inside quotes ("Becton, Dickinson and Company",
 * "Healthcare → Diagnostics & Research"), so a split(",") mis-columns roughly
 * a dozen rows and would map their sector text into asset_type.
 */
function parseCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }  // escaped quote
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

/**
 * Normalize a yfinance-shaped ticker to Alpaca's spelling at ingest (Phase 2.3
 * of docs/signal-engine-three-phase-plan.md).
 *
 * seed/universe_symbols.csv is maintained by ~/code/signals-app, which fetches
 * through **yfinance**. yfinance spells a share class with a hyphen (`BRK-B`,
 * `BF-B`); Alpaca — the portal's vendor — spells it with a dot (`BRK.B`,
 * `BF.B`). Left alone, Alpaca 400s the hyphen form and `prune-universe.mjs`
 * correctly deactivates two of the most liquid names on the tape as if
 * delisted. The CSV is correct for its own vendor, so the fix belongs here.
 *
 * Scope is deliberately narrow: `LETTERS-<single letter>` only. Preferred-share
 * notation like `SCHW-PD` is a genuinely different scheme (Alpaca writes it
 * `SCHW.PR.D`), not a separator swap, so it is left untouched and verified
 * separately.
 */
const SHARE_CLASS_RE = /^([A-Z]+)-([A-Z])$/;
export function normalizeToAlpaca(ticker) {
  const m = SHARE_CLASS_RE.exec(ticker);
  return m ? `${m[1]}.${m[2]}` : ticker;
}

/** Map the CSV's asset_type onto the portal's UniverseScope values, or null to skip. */
function scopeFor(assetType) {
  const t = (assetType ?? "").toLowerCase();
  if (t === "equity") return "stock";
  if (t === "etf" || t === "fund") return "etf";
  return null; // Crypto and anything unrecognized — see header note.
}

function loadUniverse() {
  const text = readFileSync(CSV_PATH, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = parseCsvLine(lines[0]);
  const col = {
    ticker: header.indexOf("ticker"),
    name: header.indexOf("name"),
    assetType: header.indexOf("asset_type"),
  };
  if (col.ticker === -1 || col.assetType === -1) {
    throw new Error(`${CSV_PATH}: expected 'ticker' and 'asset_type' columns, got: ${header.join(", ")}`);
  }

  const byTicker = new Map();
  const skipped = { badTicker: [], unsupportedType: [] };
  const normalized = [];

  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const rawTicker = (f[col.ticker] ?? "").toUpperCase();
    const ticker = normalizeToAlpaca(rawTicker);
    if (ticker !== rawTicker) normalized.push(`${rawTicker}→${ticker}`);
    if (!TICKER_RE.test(ticker)) { skipped.badTicker.push(rawTicker || "(blank)"); continue; }

    const universe = scopeFor(f[col.assetType]);
    if (!universe) { skipped.unsupportedType.push(ticker); continue; }
    if (ONLY && universe !== ONLY) continue;

    byTicker.set(ticker, { ticker, universe, name: f[col.name] || null });
  }

  return { entries: [...byTicker.values()], skipped, normalized };
}

async function main() {
  if (ONLY && !["stock", "etf"].includes(ONLY)) {
    throw new Error(`unknown --only=${ONLY}; expected 'stock' or 'etf'`);
  }

  process.stdout.write(`Reading ${CSV_PATH}\n`);
  const { entries, skipped, normalized } = loadUniverse();
  if (normalized.length) {
    process.stdout.write(
      `  normalized ${normalized.length} share-class ticker(s) yfinance→Alpaca: ${normalized.join(", ")}\n`,
    );
  }

  const stocks = entries.filter((e) => e.universe === "stock").length;
  const etfs = entries.filter((e) => e.universe === "etf").length;
  process.stdout.write(`  parsed ${entries.length} tickers — ${stocks} stock, ${etfs} etf\n`);
  if (skipped.unsupportedType.length) {
    process.stdout.write(`  skipped ${skipped.unsupportedType.length} unsupported (crypto/unknown): ${skipped.unsupportedType.join(", ")}\n`);
  }
  if (skipped.badTicker.length) {
    process.stdout.write(`  skipped ${skipped.badTicker.length} malformed ticker(s): ${skipped.badTicker.join(", ")}\n`);
  }

  // Enforce a floor in every mode — a truncated CSV is just as wrong for
  // --only=stock as for a full run; the minimum simply differs by mode.
  const floor =
    ONLY === "stock" ? MIN_STOCK_ROWS : ONLY === "etf" ? MIN_ETF_ROWS : MIN_ROWS;
  if (entries.length < floor) {
    throw new Error(
      `parsed only ${entries.length} tickers${ONLY ? ` for --only=${ONLY}` : ""}, ` +
        `expected at least ${floor} — refusing to register a partial universe ` +
        `(is ${CSV_PATH} truncated?)`,
    );
  }

  if (DRY_RUN) {
    process.stdout.write(`${JSON.stringify(entries.slice(0, 5), null, 2)}\n`);
    process.stdout.write(`(dry run — nothing registered; ${entries.length} tickers would be sent)\n`);
    return;
  }

  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    throw new Error("PORTAL_PUSH_SECRET is not set — the portal will reject this run");
  }

  // PUT registers membership only, implying no card — these tickers have not
  // been measured yet. Same contract as seed-universe.mjs.
  const CHUNK = 300;
  let registered = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const res = await fetch(`${PORTAL_URL}/api/pipeline/hydrate-universe`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ entries: chunk }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`portal returned HTTP ${res.status}: ${JSON.stringify(body)}`);
    registered += body.registered ?? 0;
    process.stdout.write(`  registered ${Math.min(i + CHUNK, entries.length)}/${entries.length}\n`);
  }

  process.stdout.write(`Done — ${registered} tickers registered in ticker_universe.\n`);
}

// Guarded so `normalizeToAlpaca` can be imported by a unit test without the
// seeder running as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`seed-signals-universe failed: ${err.message}\n`);
    process.exit(1);
  });
}
