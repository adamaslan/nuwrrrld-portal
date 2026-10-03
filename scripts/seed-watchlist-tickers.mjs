#!/usr/bin/env node
/**
 * seed-watchlist-tickers — add an explicit ticker list to one watchlist.
 *
 * Companion to seed-watchlist-universe.mjs, which seeds a user's watchlist
 * from the *entire* `ticker_universe`. This script exists for the narrower
 * case: a specific basket of tickers (e.g. one brokerage account's holdings)
 * that should land on its own watchlist row, not the whole universe.
 *
 * `--user` accepts any string matching the Clerk id shape (`user_...`),
 * including a synthetic id for a non-Clerk grouping (a brokerage account,
 * a basket name) — `watchlist_items.user_id` has no foreign key to Clerk,
 * so this is a deliberate, supported use of the column, not a hack. Ticker
 * rows are upserted into `ticker_universe` first (same asset_type inference
 * as seed-signals-universe.mjs) so the watchlist join never dangles.
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-watchlist-tickers.mjs --user=user_holdingsall --csv=/path/tickers.csv
 *   node --env-file=.env.local scripts/seed-watchlist-tickers.mjs --user=user_holdingsall --tickers=AAPL,MSFT --dry-run
 *   node --env-file=.env.local scripts/seed-watchlist-tickers.mjs --undo=docs/watchlist-seeds/<file>.json
 *
 * Flags:
 *   --user=<id>       target watchlist owner (user_[A-Za-z0-9]+)
 *   --csv=<path>      CSV with a `ticker` column
 *   --tickers=<list>  comma-separated tickers (alternative to --csv)
 *   --dry-run         report what would change; write nothing
 *   --undo=<path>     delete exactly the tickers listed in a prior manifest
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";

const MANIFEST_DIR = "docs/watchlist-seeds";
const BATCH_SIZE = 200;

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};

function die(msg) {
  console.error(`\n✖ seed-watchlist-tickers refused: ${msg}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) die("DATABASE_URL is not set (put it in .env.local for local dev).");
const sql = neon(url);

// Quote-aware split (same shape as seed-signals-universe.mjs): a name column
// like "Apple, Inc." must not shift the ticker column.
function parseCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

const DRY_RUN = flag("dry-run") === true;
const UNDO = flag("undo");

if (typeof UNDO === "string") {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(UNDO, "utf8"));
  } catch (err) {
    die(`could not read manifest "${UNDO}": ${err.message}`);
  }
  const { userId, tickers } = manifest;
  if (!userId || !Array.isArray(tickers)) die("manifest is missing `userId` or `tickers`.");
  console.log(`↩ Undo: removing ${tickers.length} tickers from ${userId}`);
  if (DRY_RUN) {
    console.log("  --dry-run: nothing written.");
    process.exit(0);
  }
  let removed = 0;
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const chunk = tickers.slice(i, i + BATCH_SIZE);
    const rows = await sql`
      DELETE FROM watchlist_items
      WHERE user_id = ${userId} AND ticker = ANY(${chunk})
      RETURNING ticker
    `;
    removed += rows.length;
  }
  console.log(`✓ Removed ${removed} rows (${tickers.length - removed} were already gone).`);
  process.exit(0);
}

const userId = flag("user");
if (typeof userId !== "string") die("no target user. Pass --user=<id>.");
if (!/^user_[A-Za-z0-9]+$/.test(userId)) {
  die(`"${userId}" does not match the expected shape (user_[A-Za-z0-9]+).`);
}

const csvPath = flag("csv");
const tickersFlag = flag("tickers");
let tickers = [];
if (typeof csvPath === "string") {
  const text = readFileSync(csvPath, "utf8");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const tickerIdx = header.indexOf("ticker");
  if (tickerIdx === -1) die(`"${csvPath}" has no \`ticker\` column.`);
  tickers = lines
    .slice(1)
    .map((l) => (parseCsvLine(l)[tickerIdx] ?? "").toUpperCase())
    .filter(Boolean);
} else if (typeof tickersFlag === "string") {
  tickers = tickersFlag.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
} else {
  die("no tickers — pass --csv=<path> or --tickers=SYM1,SYM2,...");
}
tickers = [...new Set(tickers)].sort();
if (tickers.length === 0) die("ticker list is empty after parsing.");

console.log(`Target user  : ${userId}`);
console.log(`Ticker count : ${tickers.length}`);

// Make sure every ticker exists in ticker_universe (default to 'stock';
// mirrors seed-signals-universe.mjs's upsert shape) so the watchlist FK-less
// join never points at a row that was never registered.
const existingUniverse = await sql`
  SELECT ticker FROM ticker_universe WHERE ticker = ANY(${tickers})
`;
const knownTickers = new Set(existingUniverse.map((r) => r.ticker));
const unregistered = tickers.filter((t) => !knownTickers.has(t));
if (unregistered.length > 0) {
  console.log(`Registering ${unregistered.length} ticker(s) not yet in ticker_universe: ${unregistered.join(", ")}`);
}

const existingRows = await sql`SELECT ticker FROM watchlist_items WHERE user_id = ${userId}`;
const existing = new Set(existingRows.map((r) => r.ticker));
const toAdd = tickers.filter((t) => !existing.has(t));

console.log(`Already on list : ${existing.size}`);
console.log(`Will add        : ${toAdd.length}`);
if (toAdd.length === 0) {
  console.log("\n✓ Nothing to do — every ticker is already on this watchlist.");
  process.exit(0);
}

if (DRY_RUN) {
  console.log(`First 10 : ${toAdd.slice(0, 10).join(", ")}`);
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

if (unregistered.length > 0) {
  for (let i = 0; i < unregistered.length; i += BATCH_SIZE) {
    const chunk = unregistered.slice(i, i + BATCH_SIZE);
    await sql`
      INSERT INTO ticker_universe (ticker, universe, name, active)
      SELECT t, 'stock', t, true FROM unnest(${chunk}::text[]) AS t
      ON CONFLICT (ticker) DO NOTHING
    `;
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const manifestPath = join(MANIFEST_DIR, `${userId}-${stamp}.json`);
const seededAt = new Date().toISOString();
mkdirSync(dirname(manifestPath), { recursive: true });
const undoHint = `node --env-file=.env.local scripts/seed-watchlist-tickers.mjs --undo=${manifestPath}`;

// Rewritten after every batch so a failure in batch N still leaves an undo
// record covering batches 1..N-1.
const writeManifest = (tickers) =>
  writeFileSync(manifestPath, `${JSON.stringify({ userId, seededAt, tickers }, null, 2)}\n`);

let inserted = 0;
const insertedTickers = [];
writeManifest(insertedTickers);
try {
  for (let i = 0; i < toAdd.length; i += BATCH_SIZE) {
    const chunk = toAdd.slice(i, i + BATCH_SIZE);
    const rows = await sql`
      INSERT INTO watchlist_items (user_id, ticker)
      SELECT ${userId}, t FROM unnest(${chunk}::text[]) AS t
      ON CONFLICT (user_id, ticker) DO NOTHING
      RETURNING ticker
    `;
    inserted += rows.length;
    insertedTickers.push(...rows.map((r) => r.ticker));
    writeManifest(insertedTickers);
  }
} catch (err) {
  console.error(`\n✖ Seeding failed after ${inserted} inserted row(s): ${err.message}`);
  console.error(`  Partial manifest: ${manifestPath}`);
  console.error(`  Undo with: ${undoHint}`);
  process.exit(1);
}
console.log(`✓ Inserted ${inserted} watchlist rows.`);
console.log(`✓ Manifest: ${manifestPath}`);
console.log(`  Undo with: ${undoHint}`);
