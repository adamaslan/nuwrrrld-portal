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
 *   node --env-file=.env.local scripts/backup-to-sqlite.mjs --chunk=5000
 *   node --env-file=.env.local scripts/backup-to-sqlite.mjs --incremental-base=backups/prev.sqlite
 *
 * --incremental-base (opt-in; the scheduled workflow does not pass it) reads
 * daily_bars rows changed since the given backup instead of the whole table,
 * and every other table in full. See scripts/backup-incremental.mjs for which
 * tables qualify and why, and scripts/backup-restore.mjs to rebuild a full
 * snapshot from full + incrementals.
 *
 * Tables are read in keyset-paginated chunks over their PRIMARY KEY (see
 * scripts/backup-pagination.mjs): Neon's serverless HTTP driver buffers each
 * query's whole result and rejects responses over 64 MB (507), which killed
 * this script once daily_bars outgrew the cap. --chunk overrides the starting
 * chunk size (default 10000 rows); it halves itself automatically if a chunk
 * still trips the cap.
 *
 * Never overwrites an existing file — each run creates a new timestamped
 * snapshot (or fails if --out already exists), so a bad run can't destroy a
 * previous good backup.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { neon } from "@neondatabase/serverless";
import { DEFAULT_CHUNK_ROWS } from "./backup-pagination.mjs";
import {
  BACKUP_FORMAT_VERSION,
  PG_CAPTURE_SQL,
  captureToMeta,
  completeInventory,
  dataTables,
  provenAbsentTables,
  createStaging,
  discardStaging,
  exportTable,
  floorCaptures,
  planIncremental,
  publishStaged,
  validateArtifact,
  schemaSha256,
  writeManifest,
} from "./backup-incremental.mjs";

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
//
// Empty as of the Phase 7 schema generator (scripts/gen-sqlite-schema.mjs):
// corpus_chunks.tsv used to be hand-dropped here, but the generator now emits
// it as a plain TEXT column (the tsvector's string representation, opaque but
// present) instead of skipping it — so it's no longer unmirrored at all.
// Keeping the mechanism for a genuine future drop, not deleting it outright.
// CodeRabbit review, PR #105.
const EXPECTED_UNMIRRORED_COLUMNS = new Set();

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
// Created in main(); owned by this invocation only (see createStaging).
let staging = null;

const schemaPath = join(process.cwd(), "lib", "db", "schema.sqlite.sql");
const schemaSql = readFileSync(schemaPath, "utf8");

const includeFilter = typeof args.tables === "string" ? new Set(args.tables.split(",")) : null;
const excludeFilter = typeof args.exclude === "string" ? new Set(args.exclude.split(",")) : new Set();
const filtered = includeFilter !== null || excludeFilter.size > 0;
const schemaSha = schemaSha256(schemaSql);

// Incremental mode: anchor the delta on the base backup's own metadata, never
// on a clock guess, so a failed night can't silently open a gap.
let incremental = null;
if (args["incremental-base"] !== undefined) {
  if (typeof args["incremental-base"] !== "string" || !existsSync(args["incremental-base"])) {
    console.error(`✖ --incremental-base must name an existing backup file`);
    process.exit(1);
  }
  if (filtered) {
    console.error("✖ --incremental-base cannot be combined with --tables/--exclude (restore needs every table)");
    process.exit(1);
  }
  const baseDb = new DatabaseSync(args["incremental-base"], { readOnly: true });
  try {
    incremental = planIncremental(validateArtifact(baseDb, args["incremental-base"]), schemaSha);
  } catch (err) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  } finally {
    baseDb.close();
  }
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

/** PRIMARY KEY columns in key order, read live like the column list above.
 * Drives keyset pagination in scripts/backup-pagination.mjs; a table with no
 * PK returns [] and falls back to OFFSET pagination there. */
async function getPrimaryKeyColumns(table) {
  const rows = await sql`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
     AND tc.table_name = kcu.table_name
    WHERE tc.table_schema = 'public'
      AND tc.table_name = ${table}
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `;
  return rows.map((r) => r.column_name);
}

async function main() {
  console.log(`Backing up ${url.replace(/:\/\/.*@/, "://***@")} -> ${outPath}\n`);
  if (incremental) {
    console.log(`Incremental: daily_bars rows changed since ${incremental.since} (base captured ${incremental.baseCapturedAt})\n`);
  }
  // Database clock (and oldest visible open transaction), read before any
  // table, so a full backup anchors the next incremental on the same clock
  // that stamps fetched_at. An incremental re-anchors on its delta snapshot.
  // window is measured on the same clock that stamps fetched_at.
  let capture = captureToMeta((await sql.query(PG_CAPTURE_SQL, []))[0]);

  // Work in a private file; only a finished, validated backup is published
  // to outPath (see publishPartial).
  staging = createStaging(outPath);
  db = new DatabaseSync(staging.path);
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

  const sourceTables = await getTables();
  let allTables = sourceTables;
  if (includeFilter) allTables = allTables.filter((t) => includeFilter.has(t));
  allTables = allTables.filter((t) => !excludeFilter.has(t));
  // A table the user explicitly omitted is "excluded" whether or not discovery
  // can see it: a permission-hidden table is absent from sourceTables, so
  // deriving the set from discovery alone would send it to the catalog check.
  const omittedByFilter = (t) => (includeFilter !== null && !includeFilter.has(t)) || excludeFilter.has(t);
  const excludedTables = new Set([
    ...sourceTables.filter((t) => !allTables.includes(t)),
    ...dataTables(db).filter(omittedByFilter),
  ]);
  // information_schema hides tables this role cannot access, so "not listed"
  // is not "absent": confirm against pg_class, which every role can read.
  const provenAbsent = await provenAbsentTables({
    mirrorTables: dataTables(db),
    sourceTables,
    excluded: excludedTables,
    baseCaptured: incremental?.capturedTables ?? new Set(),
    existsInSource: async (t) =>
      (await sql`
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${t} AND c.relkind IN ('r', 'p')
      `).length > 0,
  });

  const summary = [];
  const manifest = [];
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
    // NOTE: each chunk is read in its own implicit transaction, so a
    // snapshot taken while the DB is being written can be mixed-time across
    // (and within) tables. `PRAGMA foreign_key_check` below catches
    // cross-table FK inconsistency but not all skew. A single read-only
    // RepeatableRead transaction for every read would fix it, but neon()'s
    // HTTP `sql.transaction()` takes a static query list and can't
    // interleave the per-chunk SQLite INSERTs — and one giant read is
    // exactly what the 64 MB response cap forbids. Acceptable for a
    // manual/nightly backup of a low-write DB; revisit if it ever runs
    // against live traffic.
    const pkColumns = await getPrimaryKeyColumns(table);
    const chunkRows = args.chunk ? Number(args.chunk) : DEFAULT_CHUNK_ROWS;
    if (!Number.isInteger(chunkRows) || chunkRows < 1) {
      db.close();
      throw new Error(`--chunk must be a positive integer, got "${args.chunk}"`);
    }

    let entry;
    try {
      entry = await exportTable((text, params) => sql.query(text, params), db, {
        table,
        pgColumns,
        pkColumns,
        chunkRows,
        since: incremental?.since ?? null,
        snapshot: (stmts) =>
          sql.transaction(
            stmts.map((q) => sql.query(q.text, q.params)),
            { isolationLevel: "RepeatableRead", readOnly: true },
          ),
      });
    } catch (err) {
      throw new Error(`Failed backing up "${table}": ${err.message}`);
    }
    const rowCount = entry.rows;
    // A delta re-anchors on its own snapshot; the run-start sample stays in
    // the floor (floorCaptures never discards an earlier observation).
    if (entry.capture) capture = floorCaptures(entry.capture, capture);
    delete entry.capture;
    manifest.push(entry);
    summary.push({ table, rows: rowCount });
    const tag = entry.mode === "delta" ? ` (delta; ${entry.sourceCount} live)` : "";
    console.log(`  ✓ ${table.padEnd(32)} ${String(rowCount).padStart(6)} rows${tag}`);
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

  writeManifest(
    db,
    {
      kind: incremental ? "incremental" : "full",
      ...capture,
      format_version: BACKUP_FORMAT_VERSION,
      schema_sha256: schemaSha,
      filtered: filtered ? "1" : "0",
      ...(incremental
        ? { since: incremental.since, base_captured_at: incremental.baseCapturedAt, parent_artifact_id: incremental.parentArtifactId }
        : {}),
    },
    // One entry per data table in the file, including tables the source DB
    // lacks ("absent") and tables a filter skipped ("excluded").
    completeInventory(db, manifest, excludedTables, provenAbsent),
  );
  // Self-check before publishing: the file must be what its metadata claims.
  // Filtered (--tables/--exclude) backups are valid files but never chain
  // anchors, so they skip the chain-level check.
  if (!filtered) validateArtifact(db, staging.path);
  publishStaged(db, staging, outPath);
  db = null;

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const totalRows = summary.reduce((s, t) => s + t.rows, 0);
  console.log(`\nDone in ${elapsed}s — ${summary.length} tables, ${totalRows} rows -> ${outPath}`);
  console.log(`Inspect it with: sqlite3 ${outPath} ".tables"`);
}

main().catch((err) => {
  console.error("\n✖ Backup failed:", err.message);
  // Only this run's staging directory is removed. outPath is written solely
  // by publishStaged's no-overwrite link, so a failure can neither leave a
  // half-written file there nor destroy a previous good backup. A hard kill
  // leaves at most a dot-prefixed staging directory, which never matches
  // backups/*.sqlite and whose file fails validateArtifact.
  try { db?.close(); } catch { /* already closed, or never opened */ }
  discardStaging(staging);
  process.exit(1);
});

