#!/usr/bin/env node
/**
 * backup-to-sqlite.mjs — snapshot every table in the Neon database (DATABASE_URL)
 * into a single local SQLite file, using Node's built-in `node:sqlite` (Node
 * 22.5+, experimental — no native dependency, no `npm install` required).
 *
 * This is a point-in-time READ-ONLY export, not a live mirror: the app never
 * reads or writes the resulting file. It exists so a full copy of the portal's
 * data survives a Neon outage/deletion and can be inspected offline with any
 * plain SQLite client (`sqlite3 backups/....sqlite`), no credentials needed.
 *
 * Schema translation lives in lib/db/schema.sqlite.sql (see that file's header
 * for the type-mapping rationale: jsonb/arrays -> JSON text, timestamptz/date
 * -> ISO strings, numeric -> REAL). Column types are read live from
 * information_schema.columns rather than hardcoded, so this script doesn't
 * drift from lib/db/schema.sql as tables are added.
 *
 *   node --env-file=.env.local scripts/backup-to-sqlite.mjs
 *   node --env-file=.env.local scripts/backup-to-sqlite.mjs --out=backups/manual.sqlite
 *   node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=ticker_universe,ticker_cards
 *   node --env-file=.env.local scripts/backup-to-sqlite.mjs --exclude=corpus_chunks,grounding_pack
 *
 * Never overwrites an existing file — each run creates a new timestamped
 * snapshot (or fails if --out already exists), so a bad run can't destroy a
 * previous good backup.
 */
import { readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { neon } from "@neondatabase/serverless";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

// ── env loading (mirrors scripts/db-migrate.mjs) ─────────────────────────────
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
    // .env.local absent — process.env is the only source.
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — cannot back up. Set it in .env.local.");
  process.exit(1);
}

const sql = neon(url);

// Postgres columns deliberately dropped from the SQLite mirror (see
// schema.sqlite.sql's header). Any *other* live column missing from the mirror
// is an error, not something to silently omit from the backup.
const EXPECTED_UNMIRRORED_COLUMNS = new Set(["corpus_chunks.tsv"]);

// Set once `main()` opens the output DB, so the top-level failure handler can
// close it and delete a half-written snapshot.
let db = null;

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

const outPath = args.out ?? join("backups", `nuwrrrld-${timestampSlug()}.sqlite`);
if (existsSync(outPath)) {
  console.error(`✖ ${outPath} already exists — refusing to overwrite a backup. Pick a new --out path.`);
  process.exit(1);
}
mkdirSync(dirname(outPath), { recursive: true });

const schemaPath = join(process.cwd(), "lib", "db", "schema.sqlite.sql");
const schemaSql = readFileSync(schemaPath, "utf8");

const includeFilter = typeof args.tables === "string" ? new Set(args.tables.split(",")) : null;
const excludeFilter = typeof args.exclude === "string" ? new Set(args.exclude.split(",")) : new Set();

/** Coerce one Postgres value into a SQLite-storable primitive, using the
 * column's Postgres data_type (from information_schema) to decide how. */
function coerce(value, pgType) {
  if (value === null || value === undefined) return null;
  if (pgType === "ARRAY" || pgType === "jsonb" || pgType === "json") {
    return JSON.stringify(value);
  }
  if (pgType === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (pgType === "integer" || pgType === "bigint" || pgType === "smallint") {
    return typeof value === "bigint" ? Number(value) : value;
  }
  if (pgType === "numeric" || pgType === "real" || pgType === "double precision") {
    return typeof value === "string" ? Number(value) : value;
  }
  // text, uuid, character varying, date-as-string, inet, tsvector (skipped
  // entirely — see schema.sqlite.sql), and anything else: pass through.
  return value;
}

async function getTables() {
  const rows = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((r) => r.table_name);
}

async function getColumns(table) {
  const rows = await sql`
    SELECT column_name, data_type, udt_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `;
  return rows;
}

async function main() {
  console.log(`Backing up ${url.replace(/:\/\/.*@/, "://***@")} -> ${outPath}\n`);

  db = new DatabaseSync(outPath);
  db.exec("PRAGMA journal_mode = WAL;");
  // Bulk-loading a full snapshot table-by-table (in information_schema's
  // alphabetical order, not dependency order — e.g. ticker_cards sorts before
  // its own ticker_universe parent) will violate FK constraints mid-import
  // even though the finished file is fully consistent. Off for the load,
  // re-verified once everything is in.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(schemaSql);
  // schema.sqlite.sql itself turns foreign_keys back ON (it's meant to be the
  // correct default for any *other* tool opening this file) — re-disable for
  // the load, then turn back on for the post-load PRAGMA foreign_key_check.
  db.exec("PRAGMA foreign_keys = OFF;");

  let allTables = await getTables();
  if (includeFilter) allTables = allTables.filter((t) => includeFilter.has(t));
  allTables = allTables.filter((t) => !excludeFilter.has(t));

  const summary = [];
  const started = Date.now();

  for (const table of allTables) {
    // Confirm this table actually exists in the SQLite mirror before querying
    // Neon for its rows — a table added to schema.sql but not yet ported to
    // schema.sqlite.sql should skip loudly, not half-insert and throw.
    const sqliteCols = db.prepare(`PRAGMA table_info("${table}")`).all();
    if (!sqliteCols.length) {
      console.warn(`  ⚠ skipping "${table}" — not present in lib/db/schema.sqlite.sql yet`);
      continue;
    }
    const sqliteColNames = new Set(sqliteCols.map((c) => c.name));

    // Only select/insert columns the SQLite mirror actually has — a Postgres
    // GENERATED column like corpus_chunks.tsv (dropped in the mirror, see
    // schema.sqlite.sql's header) must never reach `SELECT *`/INSERT.
    const allPgColumns = await getColumns(table);
    // A live column absent from the mirror that ISN'T one of the known-dropped
    // ones means schema.sqlite.sql has drifted behind schema.sql — fail loudly
    // rather than ship a backup that's silently missing a column.
    const unexpectedlyMissing = allPgColumns
      .filter((c) => !sqliteColNames.has(c.column_name))
      .map((c) => `${table}.${c.column_name}`)
      .filter((q) => !EXPECTED_UNMIRRORED_COLUMNS.has(q));
    if (unexpectedlyMissing.length) {
      db.close();
      throw new Error(
        `Live column(s) not present in lib/db/schema.sqlite.sql (add them there, ` +
        `or list them in EXPECTED_UNMIRRORED_COLUMNS if intentionally dropped): ` +
        unexpectedlyMissing.join(", "),
      );
    }
    const pgColumns = allPgColumns.filter((c) => sqliteColNames.has(c.column_name));
    const colNames = pgColumns.map((c) => c.column_name);
    const selectList = colNames.map((c) => `"${c}"`).join(", ");
    // NOTE: each table is read in its own implicit transaction, so a snapshot
    // taken while the DB is being written can be mixed-time across tables.
    // `PRAGMA foreign_key_check` below catches cross-table FK inconsistency but
    // not all skew. A single read-only RepeatableRead transaction for every
    // read would fix it, but neon()'s `sql.transaction()` takes a static query
    // list and can't interleave the per-table SQLite INSERTs — that needs a
    // read-all-then-write-all restructure. Acceptable for a manual/nightly
    // backup of a low-write DB; revisit if it ever runs against live traffic.
    const rows = await sql.query(`SELECT ${selectList} FROM "${table}"`);

    if (rows.length) {
      const placeholders = colNames.map(() => "?").join(", ");
      const insert = db.prepare(
        `INSERT INTO "${table}" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
      );
      db.exec("BEGIN");
      try {
        for (const row of rows) {
          const values = pgColumns.map((c) => coerce(row[c.column_name], c.data_type));
          insert.run(...values);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new Error(`Failed inserting into "${table}": ${err.message}`);
      }
    }

    summary.push({ table, rows: rows.length });
    console.log(`  ✓ ${table.padEnd(32)} ${String(rows.length).padStart(6)} rows`);
  }

  // Re-enable and verify: a real FK violation in the exported data (not just
  // load-order noise) should fail loudly rather than ship a silently-broken
  // backup file.
  db.exec("PRAGMA foreign_keys = ON;");
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) {
    db.close();
    throw new Error(
      `${violations.length} foreign-key violation(s) in the exported data (not a load-order artifact): ` +
      JSON.stringify(violations.slice(0, 5)),
    );
  }

  db.close();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const totalRows = summary.reduce((s, t) => s + t.rows, 0);
  console.log(`\nDone in ${elapsed}s — ${summary.length} tables, ${totalRows} rows -> ${outPath}`);
  console.log(`Inspect it with: sqlite3 ${outPath} ".tables"`);
}

main().catch((err) => {
  console.error("\n✖ Backup failed:", err.message);
  // Don't leave a half-written snapshot behind: it would make the next run's
  // `existsSync(outPath)` guard refuse to retry, and the documented path could
  // look like a finished backup. `main()` only ever creates `outPath` fresh
  // (it exits early if the path already existed), so removing it + its WAL/SHM
  // sidecars here can't destroy a previous good backup.
  try { db?.close(); } catch { /* already closed, or never opened */ }
  for (const stale of [outPath, `${outPath}-wal`, `${outPath}-shm`]) {
    try { if (existsSync(stale)) rmSync(stale); } catch { /* best-effort */ }
  }
  process.exit(1);
});
