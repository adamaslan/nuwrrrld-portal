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
const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] ?? null;
const CSV_PATH =
  process.argv.find((a) => a.startsWith("--csv="))?.split("=")[1] ??
  join(homedir(), "code", "signals-app", "seed", "universe_symbols.csv");

// Same guard as seed-universe.mjs: a truncated read or a changed file layout
// should fail loud rather than silently register a handful of rows.
const MIN_ROWS = 800;

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

  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const ticker = (f[col.ticker] ?? "").toUpperCase();
    if (!TICKER_RE.test(ticker)) { skipped.badTicker.push(ticker || "(blank)"); continue; }

    const universe = scopeFor(f[col.assetType]);
    if (!universe) { skipped.unsupportedType.push(ticker); continue; }
    if (ONLY && universe !== ONLY) continue;

    byTicker.set(ticker, { ticker, universe, name: f[col.name] || null });
  }

  return { entries: [...byTicker.values()], skipped };
}

async function main() {
  if (ONLY && !["stock", "etf"].includes(ONLY)) {
    throw new Error(`unknown --only=${ONLY}; expected 'stock' or 'etf'`);
  }

  process.stdout.write(`Reading ${CSV_PATH}\n`);
  const { entries, skipped } = loadUniverse();

  const stocks = entries.filter((e) => e.universe === "stock").length;
  const etfs = entries.filter((e) => e.universe === "etf").length;
  process.stdout.write(`  parsed ${entries.length} tickers — ${stocks} stock, ${etfs} etf\n`);
  if (skipped.unsupportedType.length) {
    process.stdout.write(`  skipped ${skipped.unsupportedType.length} unsupported (crypto/unknown): ${skipped.unsupportedType.join(", ")}\n`);
  }
  if (skipped.badTicker.length) {
    process.stdout.write(`  skipped ${skipped.badTicker.length} malformed ticker(s): ${skipped.badTicker.join(", ")}\n`);
  }

  // Only enforce the floor on a full run; --only=etf legitimately yields ~172.
  if (!ONLY && entries.length < MIN_ROWS) {
    throw new Error(
      `parsed only ${entries.length} tickers, expected at least ${MIN_ROWS} — ` +
        `refusing to register a partial universe (is ${CSV_PATH} truncated?)`,
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

main().catch((err) => {
  process.stderr.write(`seed-signals-universe failed: ${err.message}\n`);
  process.exit(1);
});
