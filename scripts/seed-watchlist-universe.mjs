#!/usr/bin/env node
/**
 * seed-watchlist-universe — bulk-add the registered signals-app universe
 * (~980 tickers in `ticker_universe`) to one user's watchlist.
 *
 * The watchlist is primary user data, not a cache, so this script is
 * deliberately more careful than the other seeders:
 *
 *   • the target user must be named explicitly (`--user=` or `--dev`); there
 *     is no default, because "whose watchlist" is not a guessable value
 *   • every run writes a manifest of exactly which tickers it inserted, and
 *     `--undo=<manifest>` removes precisely those — so a 980-row seed never
 *     has to be unwound by hand, and never takes pre-existing rows with it
 *   • rows already on the watchlist are skipped and reported, not re-dated
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-watchlist-universe.mjs --dev
 *   node --env-file=.env.local scripts/seed-watchlist-universe.mjs --user=user_xxx --dry-run
 *   node --env-file=.env.local scripts/seed-watchlist-universe.mjs --user=user_xxx
 *   node --env-file=.env.local scripts/seed-watchlist-universe.mjs --undo=docs/watchlist-seeds/<file>.json
 *
 * Flags:
 *   --dev             target the local hydrate user (user_devlocal000000000000000)
 *   --user=<clerkId>  target a specific Clerk user id
 *   --only=stock|etf  restrict to one universe (default: both)
 *   --limit=N         cap how many tickers are added
 *   --include-inactive  also add `active = false` rows (default: active only)
 *   --dry-run         report what would change; write nothing
 *   --undo=<path>     delete exactly the tickers listed in a prior manifest
 *
 * Note this does NOT enqueue a signal refresh per ticker the way the
 * POST /api/portfolio/watchlist route does. That route enqueues one job per
 * add, which is right for a single interactive add and catastrophic for 980 —
 * the universe already has computed `ticker_cards`, which is what the
 * portfolio surfaces read.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { neon } from "@neondatabase/serverless";

// ── env loading (mirrors scripts/hydrate-dev.mjs) ────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of envLocal.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[m[1]] = val;
      }
    }
  } catch {
    /* .env.local absent — process.env is the only source */
  }
}

const DEV_USER_ID = "user_devlocal000000000000000";
const MANIFEST_DIR = "docs/watchlist-seeds";
/** Rows per INSERT. Neon's HTTP driver has a statement-size ceiling and a
 *  980-row single insert sits uncomfortably close to it. */
const BATCH_SIZE = 200;

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};

function die(msg) {
  console.error(`\n✖ seed-watchlist-universe refused: ${msg}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) die("DATABASE_URL is not set (put it in .env.local for local dev).");
const sql = neon(url);

const DRY_RUN = flag("dry-run") === true;
const UNDO = flag("undo");

// ── undo ─────────────────────────────────────────────────────────────────────
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

// ── target user ──────────────────────────────────────────────────────────────
const userFlag = flag("user");
const userId = flag("dev") === true ? DEV_USER_ID : typeof userFlag === "string" ? userFlag : null;
if (!userId) {
  die(
    "no target user. Pass --dev for the local hydrate user, or --user=<clerkUserId>. " +
      "There is no default: this writes to a real person's watchlist.",
  );
}
if (!/^user_[A-Za-z0-9]+$/.test(userId)) {
  die(`"${userId}" does not look like a Clerk user id (expected user_...).`);
}

const only = flag("only");
if (only !== undefined && only !== "stock" && only !== "etf") {
  die(`--only must be "stock" or "etf" (got "${only}").`);
}
const limitRaw = flag("limit");
const limit = typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : null;
if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
  die(`--limit must be a positive integer (got "${limitRaw}").`);
}
const includeInactive = flag("include-inactive") === true;

// ── read universe + current watchlist ────────────────────────────────────────
const universeRows = await sql`
  SELECT ticker, universe FROM ticker_universe
  WHERE (${includeInactive}::boolean OR active)
    AND (${only ?? null}::text IS NULL OR universe = ${only ?? null})
  ORDER BY ticker
`;
if (universeRows.length === 0) {
  die("ticker_universe returned no rows for that filter — run scripts/seed-signals-universe.mjs first.");
}

const existingRows = await sql`SELECT ticker FROM watchlist_items WHERE user_id = ${userId}`;
const existing = new Set(existingRows.map((r) => r.ticker));

const candidates = universeRows.map((r) => r.ticker).filter((t) => !existing.has(t));
const toAdd = limit === null ? candidates : candidates.slice(0, limit);

const etfCount = universeRows.filter((r) => r.universe === "etf").length;
console.log(`Target user      : ${userId}`);
console.log(`Universe matched : ${universeRows.length} (${etfCount} etf · ${universeRows.length - etfCount} stock)`);
console.log(`Already on list  : ${existing.size}`);
console.log(`Will add         : ${toAdd.length}`);
if (toAdd.length === 0) {
  console.log("\n✓ Nothing to do — every matched ticker is already on the watchlist.");
  process.exit(0);
}
console.log(`First 10         : ${toAdd.slice(0, 10).join(", ")}`);

if (DRY_RUN) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

// ── insert ───────────────────────────────────────────────────────────────────
let inserted = 0;
for (let i = 0; i < toAdd.length; i += BATCH_SIZE) {
  const chunk = toAdd.slice(i, i + BATCH_SIZE);
  const rows = await sql`
    INSERT INTO watchlist_items (user_id, ticker)
    SELECT ${userId}, t FROM unnest(${chunk}::text[]) AS t
    ON CONFLICT (user_id, ticker) DO NOTHING
    RETURNING ticker
  `;
  inserted += rows.length;
  process.stdout.write(`  inserted ${inserted}/${toAdd.length}\r`);
}
console.log(`\n✓ Inserted ${inserted} watchlist rows.`);

// ── manifest (makes the run reversible) ──────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const manifestPath = join(MANIFEST_DIR, `${userId}-${stamp}.json`);
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(
  manifestPath,
  `${JSON.stringify({ userId, seededAt: new Date().toISOString(), only: only ?? "all", tickers: toAdd }, null, 2)}\n`,
);
console.log(`✓ Manifest: ${manifestPath}`);
console.log(`  Undo with: node --env-file=.env.local scripts/seed-watchlist-universe.mjs --undo=${manifestPath}`);
