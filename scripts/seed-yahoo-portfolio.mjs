#!/usr/bin/env node
/**
 * seed-yahoo-portfolio — register tickers exported from Yahoo Finance
 * "portfolio.csv" downloads into `ticker_universe`, the same way
 * scripts/seed-universe.mjs registers S&P 500 / Nasdaq-100 constituents.
 *
 * Source: a directory of Yahoo Finance portfolio CSV exports (Symbol,Current
 * Price,Date,Time,... columns — the standard "Export" button format). Yahoo
 * paginates portfolio exports across multiple files ("portfolio.csv",
 * "portfolio (1).csv", "portfolio (2).csv", ...); this script reads every
 * *.csv in the given directory and unions the Symbol column.
 *
 * Non-US tickers (Yahoo suffix notation like "3750.HK", "WIZZ.L") are
 * skipped, not registered as 'stock': Alpaca (the only data source
 * deploy/universe-hydration/modal_app.py knows how to hydrate from) only
 * covers US-listed equities, so registering a Hong Kong or London ticker
 * would just guarantee a permanent per-symbol hydration failure.
 *
 * A file whose content isn't real CSV (Yahoo occasionally serves a
 * "temporarily unavailable" plaintext error page in place of a download) is
 * skipped with a warning rather than treated as zero valid tickers found.
 *
 * Usage:
 *   PORTAL_PUSH_SECRET=... node scripts/seed-yahoo-portfolio.mjs /path/to/dir
 *   PORTAL_PUSH_SECRET=... PORTAL_URL=http://localhost:3000 node scripts/seed-yahoo-portfolio.mjs /path/to/dir
 *   node scripts/seed-yahoo-portfolio.mjs /path/to/dir --dry-run
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DRY_RUN = process.argv.includes("--dry-run");
const DIR = process.argv[2];

// Same shape lib/shared/signal-policy.ts's normalizeTicker accepts server-side;
// checked here too so rejects are visible before the network call, not just
// counted in the portal's response.
const TICKER_RE = /^[A-Z][A-Z.\-]{0,9}$/;
// Yahoo's suffix notation for non-US exchanges (".HK", ".L", ".TO", ".AX", ...).
// US share-class tickers use a dot too (BRK.B) but with a single letter after
// it; a non-US suffix is 1-3 letters that don't look like a share class in
// practice for this portfolio, so the safer rule is: a dot followed by 2+
// letters, or a known-suffix single-letter list, is foreign.
const NON_US_SUFFIX_RE = /\.(HK|L|TO|AX|SI|SS|SZ|T|PA|DE|MI|MC|AS|BR|VI|SW|ST|CO|OL|HE|IS|KS|KQ|TA|JK|NS|BO|BK|NZ)$/;

function isUsTicker(ticker) {
  return TICKER_RE.test(ticker) && !NON_US_SUFFIX_RE.test(ticker);
}

/** Minimal CSV line splitter — good enough for Yahoo's export, which never
 *  quotes the Symbol column (tickers can't contain commas). */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const symbolIdx = header.findIndex((h) => h.trim().toLowerCase() === "symbol");
  if (symbolIdx === -1) return [];
  return lines.slice(1).map((line) => line.split(",")[symbolIdx]?.trim() ?? "");
}

function main() {
  if (!DIR) {
    throw new Error("usage: node scripts/seed-yahoo-portfolio.mjs <dir> [--dry-run]");
  }

  const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith(".csv"));
  if (files.length === 0) {
    throw new Error(`no .csv files found in ${DIR}`);
  }

  const byTicker = new Set();
  const nonUs = new Set();
  const rejected = new Set();
  let skippedFiles = 0;

  for (const file of files) {
    const text = readFileSync(join(DIR, file), "utf8");
    const symbols = parseCsv(text);
    if (symbols.length === 0) {
      skippedFiles++;
      process.stdout.write(`  skip ${file}: no usable Symbol column (likely an error page, not a CSV export)\n`);
      continue;
    }
    for (const raw of symbols) {
      if (!raw) continue;
      const ticker = raw.toUpperCase();
      if (!TICKER_RE.test(ticker)) {
        rejected.add(ticker);
        continue;
      }
      if (!isUsTicker(ticker)) {
        nonUs.add(ticker);
        continue;
      }
      byTicker.add(ticker);
    }
  }

  process.stdout.write(
    `Parsed ${files.length} files (${skippedFiles} skipped as unusable). ` +
      `${byTicker.size} distinct US tickers, ${nonUs.size} non-US skipped, ${rejected.size} rejected.\n`,
  );

  if (nonUs.size > 0) {
    process.stdout.write(`  non-US (skipped): ${[...nonUs].sort().join(", ")}\n`);
  }
  if (rejected.size > 0) {
    process.stdout.write(`  rejected (bad shape): ${[...rejected].sort().join(", ")}\n`);
  }

  const entries = [...byTicker].sort().map((ticker) => ({ ticker, universe: "stock" }));

  if (DRY_RUN) {
    process.stdout.write(`${JSON.stringify(entries.slice(0, 10), null, 2)}\n`);
    process.stdout.write(`(dry run — nothing registered; ${entries.length} tickers would be sent)\n`);
    return Promise.resolve();
  }

  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    throw new Error("PORTAL_PUSH_SECRET is not set — the portal will reject this run");
  }

  return registerAll(entries, secret);
}

async function registerAll(entries, secret) {
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
  process.stderr.write(`seed-yahoo-portfolio failed: ${err.message}\n`);
  process.exitCode = 1;
});
