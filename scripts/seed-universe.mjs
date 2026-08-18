#!/usr/bin/env node
/**
 * seed-universe — register S&P 500 + Nasdaq-100 constituents into
 * `ticker_universe`, so the hydration lane (deploy/universe-hydration/modal_app.py)
 * has a real "stock" universe to walk instead of only the tickers a hydration
 * batch happens to self-register.
 *
 * Without this, `hydrate_universe_eod()`'s GET /api/pipeline/hydrate-universe
 * returns whatever has already been carded — which is nothing on a fresh
 * deploy — so the very first run has zero symbols to fetch. This script is
 * what makes "4,300 tickers, zero AI cost" concretely true rather than
 * aspirational: it is the one step that turns an empty universe into a real one.
 *
 * Source: Wikipedia's "List of S&P 500 companies" and "List of NASDAQ-100
 * companies" — both carry a `<table id="constituents">` with ticker in the
 * first column. Free, no key, no rate limit, and maintained by editors when
 * index composition actually changes (additions/removals are usually reflected
 * within days). The tradeoff: it's HTML-table scraping, not an API, so a
 * Wikipedia markup change can break the parser — this is why the script prints
 * a row count and refuses to write a suspiciously small result (see MIN_ROWS).
 *
 * Overlap with the 54-ETF universe is expected and harmless: `upsertUniverse`
 * only sets `universe` on conflict, and the ETF seed (seed-etf-cards.mjs)
 * always registers its own rows as 'etf' immediately before carding them, so
 * a stock-vs-ETF collision (e.g. a ticker that is coincidentally both) would
 * just track whichever ran last — not a case that occurs among these two
 * source lists today.
 *
 * Usage:
 *   PORTAL_PUSH_SECRET=... node scripts/seed-universe.mjs
 *   PORTAL_PUSH_SECRET=... PORTAL_URL=http://localhost:3000 node scripts/seed-universe.mjs
 *   node scripts/seed-universe.mjs --dry-run     # print counts, register nothing
 *   node scripts/seed-universe.mjs --only=sp500   # or --only=nasdaq100
 */

const PORTAL_URL = (process.env.PORTAL_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DRY_RUN = process.argv.includes("--dry-run");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.split("=")[1] ?? null;

const SOURCES = {
  sp500: "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
  nasdaq100: "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies",
};

// A parser regression (Wikipedia changes the table's markup) should fail loud,
// not silently register a handful of rows as though that were the whole index.
const MIN_ROWS = { sp500: 480, nasdaq100: 95 };

// Tickers as Wikipedia prints them use a dot for share classes (BRK.B);
// lib/shared/signal-policy.ts's normalizeTicker also accepts a hyphen, so this
// just needs to reject junk, not reformat anything.
const TICKER_RE = /^[A-Z][A-Z.\-]{0,9}$/;

/** Fetch one Wikipedia article's raw HTML. A UA header is required — Wikipedia
 *  rate-limits or blocks default-looking bot user agents on some paths. */
async function fetchArticle(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "nuwrrrld-portal-universe-seed/1.0 (contact: chillcoders@gmail.com)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

/**
 * Extract {ticker, name} rows from a `<table id="constituents">` where the
 * ticker is the first `<td>` and the company name is the second. Both source
 * pages share this exact shape.
 */
function parseConstituents(html, label) {
  const tableMatch = html.match(/<table[^>]*id="constituents"[^>]*>[\s\S]*?<\/table>/);
  if (!tableMatch) {
    throw new Error(`${label}: no <table id="constituents"> found — page structure may have changed`);
  }

  const rows = tableMatch[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const out = [];

  for (const row of rows.slice(1)) {
    // Header row filtered by slice(1); data rows use <td>, not <th>.
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 2) continue;

    const ticker = stripTags(cells[0]).trim().toUpperCase().replace(/\s+/g, "");
    const name = stripTags(cells[1]).trim();
    if (TICKER_RE.test(ticker) && name) out.push({ ticker, name });
  }

  return out;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "");
}

async function loadIndex(key, url) {
  process.stdout.write(`Fetching ${key} from ${url} …\n`);
  const html = await fetchArticle(url);
  const rows = parseConstituents(html, key);

  if (rows.length < MIN_ROWS[key]) {
    throw new Error(
      `${key}: parsed only ${rows.length} rows, expected at least ${MIN_ROWS[key]} — ` +
        `refusing to register a partial index (Wikipedia's table markup may have changed)`,
    );
  }

  process.stdout.write(`  ${key}: ${rows.length} constituents parsed\n`);
  return rows;
}

async function main() {
  const wanted = ONLY ? { [ONLY]: SOURCES[ONLY] } : SOURCES;
  if (ONLY && !SOURCES[ONLY]) {
    throw new Error(`unknown --only=${ONLY}; expected one of: ${Object.keys(SOURCES).join(", ")}`);
  }

  const byTicker = new Map();
  for (const [key, url] of Object.entries(wanted)) {
    const rows = await loadIndex(key, url);
    for (const { ticker, name } of rows) {
      // A ticker in both indices (common — most Nasdaq-100 names are also in
      // the S&P 500) is registered once; the name from whichever list is
      // processed last wins, which is immaterial since both list the same company.
      byTicker.set(ticker, name);
    }
  }

  const entries = [...byTicker.entries()].map(([ticker, name]) => ({ ticker, universe: "stock", name }));
  process.stdout.write(`Total distinct tickers across selected indices: ${entries.length}\n`);

  if (DRY_RUN) {
    process.stdout.write(`${JSON.stringify(entries.slice(0, 5), null, 2)}\n`);
    process.stdout.write(`(dry run — nothing registered; ${entries.length} tickers would be sent)\n`);
    return;
  }

  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    throw new Error("PORTAL_PUSH_SECRET is not set — the portal will reject this run");
  }

  // PUT registers membership with no card implied — POSTing a fake "status:
  // error" row for every ticker would be the wrong shape here, since these
  // tickers haven't been measured at all yet, and a card record should never
  // suggest otherwise.
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
  process.stderr.write(`seed-universe failed: ${err.message}\n`);
  process.exitCode = 1;
});
