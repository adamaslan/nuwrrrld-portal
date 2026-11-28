/**
 * backup-incremental.mjs — opt-in incremental mode for backup-to-sqlite.mjs.
 *
 * Why this exists: every nightly run re-reads the whole database over Neon's
 * HTTP driver. On 2026-11-25 that was 990,285 rows, 768,155 of them
 * daily_bars, which grows by roughly one bar per ticker per weekday. Gzipping
 * the artifact afterwards does not change what left Neon. An incremental run
 * reads daily_bars rows changed since the previous backup instead of all of
 * them, and still reads every other table in full.
 *
 * Which tables may be read incrementally (INCREMENTAL_TABLES) is a safety
 * decision, not a size one. A table qualifies only when:
 *   - every INSERT and every content-changing UPDATE sets one watermark
 *     column to the database's now(), and
 *   - no code path deletes rows (deletes are not visible in a delta).
 * daily_bars qualifies: lib/engine-db.ts upsertBars() is its only writer, the
 * insert defaults fetched_at to now() and ON CONFLICT sets fetched_at = now(),
 * and nothing deletes from it. These do NOT qualify and stay full every run:
 *   - news_articles: modal_app.py sets corroborated = true without touching
 *     updated_at, so an updated row would be missed.
 *   - news_article_symbols: no timestamp column at all.
 *   - news_article_scores: insert-only, but rows vanish by ON DELETE CASCADE
 *     when an article is deleted, and a delta cannot see that.
 *
 * Consistency: the delta rows, the table's live count and the clock that
 * anchors the next run are read in ONE read-only REPEATABLE READ transaction
 * (one HTTP request). A delta therefore cannot exceed Neon's 64 MB response
 * cap; if it does, the run fails and a full backup is the remedy.
 *
 * Late commits: now() is transaction START time, so a writer that began
 * before a backup's snapshot and committed after it stamps rows older than
 * the snapshot. The next delta starts at the earlier of (snapshot − 6h) and
 * the oldest open transaction the snapshot could see in pg_stat_activity.
 * If some sessions were not visible to this role, only the 6h overlap
 * protects; the file records late_commit_bound = "overlap-only" and restore
 * carries that label forward. A writer transaction open longer than 6h that
 * this role cannot see can then be missed until the next full backup.
 *
 * Each backup file carries _backup_meta (kind, captured_at, schema and shape
 * hashes, base link) and _backup_manifest (per-table mode, rows, live count),
 * written in the same transaction, and is published by an atomic no-overwrite
 * rename from a private .partial file. validateArtifact() re-derives the
 * facts the metadata claims before a file is used as a base or restored.
 */
import { createHash } from "node:crypto";
import { existsSync, linkSync, rmSync, unlinkSync } from "node:fs";
import { fetchTableChunks, isResponseTooLargeError, DEFAULT_CHUNK_ROWS } from "./backup-pagination.mjs";

export const BACKUP_FORMAT_VERSION = "2";

/** table -> watermark column. See the header for why only daily_bars. */
export const INCREMENTAL_TABLES = Object.freeze({ daily_bars: "fetched_at" });

/** Minimum reach-back before a base snapshot (see "Late commits" above). */
export const OVERLAP_MS = 6 * 60 * 60 * 1000;

export const META_TABLE = "_backup_meta";
export const MANIFEST_TABLE = "_backup_manifest";

/**
 * Database clock plus the oldest open transaction this role can see, and how
 * many client sessions it cannot see into. One row.
 */
export const PG_CAPTURE_SQL = `
  SELECT now() AS now,
    (SELECT min(xact_start) FROM pg_stat_activity
      WHERE xact_start IS NOT NULL AND pid <> pg_backend_pid()) AS oldest_open_xact_at,
    (SELECT count(*) FROM pg_stat_activity
      WHERE backend_type = 'client backend' AND state IS NULL AND pid <> pg_backend_pid())::int AS invisible_sessions`;

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
const toIso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

export function schemaSha256(schemaSql) {
  return createHash("sha256").update(schemaSql).digest("hex");
}

/** Hash of the file's actual table/column layout, metadata tables excluded. */
export function shapeSha256(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN (?, ?) ORDER BY name")
    .all(META_TABLE, MANIFEST_TABLE)
    .map((r) => r.name);
  const parts = tables.map((t) => {
    const cols = db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all();
    return `${t}(${cols.map((c) => `${c.name}:${c.type}:${c.pk}`).join(",")})`;
  });
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** Normalise one capture row into metadata fields. */
export function captureToMeta(row) {
  return {
    captured_at: toIso(row.now),
    oldest_open_xact_at: toIso(row.oldest_open_xact_at),
    late_commit_bound: Number(row.invisible_sessions ?? 0) > 0 ? "overlap-only" : "observed",
  };
}

/** Coerce one Postgres value into a SQLite-storable primitive, using the
 * column's Postgres data_type (from information_schema) to decide how. */
export function coerce(value, pgType) {
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
  // text, uuid, character varying, date-as-string, inet, tsvector, and
  // anything else: pass through.
  return value;
}

/**
 * Read a backup file's _backup_meta as a plain object ({} if absent).
 * @returns {Record<string, string>}
 */
export function readMeta(db) {
  if (!hasTable(db, META_TABLE)) return {};
  const out = {};
  for (const r of db.prepare(`SELECT key, value FROM ${META_TABLE}`).all()) out[r.key] = r.value;
  return out;
}

/**
 * Read a backup file's _backup_manifest keyed by table name ({} if absent).
 * @returns {Record<string, { table_name: string, mode: string, rows: number, source_count: number | null }>}
 */
export function readManifest(db) {
  if (!hasTable(db, MANIFEST_TABLE)) return {};
  const out = {};
  for (const r of db.prepare(`SELECT * FROM ${MANIFEST_TABLE}`).all()) out[r.table_name] = r;
  return out;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/**
 * Check that a backup file is what its metadata says, by re-deriving it:
 * kind, filter state, schema shape, manifest modes, actual row counts and
 * mandatory delta counts. Throws on the first mismatch. Used for a CLI base,
 * planIncremental and every restore link.
 *
 * @returns {{ meta: Record<string, string>, manifest: Record<string, { table_name: string, mode: string, rows: number, source_count: number | null }> }}
 */
export function validateArtifact(db, label = "backup") {
  const meta = readMeta(db);
  const manifest = readManifest(db);
  const fail = (msg) => {
    throw new Error(`${label}: ${msg}`);
  };
  if (meta.format_version !== BACKUP_FORMAT_VERSION) {
    fail(`unsupported or missing backup format ${meta.format_version ?? "(none)"} — take a full backup first`);
  }
  if (meta.kind !== "full" && meta.kind !== "incremental") fail(`kind must be full or incremental, got ${meta.kind}`);
  if (meta.filtered !== "0") fail("filtered (--tables/--exclude) backups cannot anchor or join a restore chain");
  if (!Number.isFinite(Date.parse(meta.captured_at))) fail(`captured_at is not a timestamp: ${meta.captured_at}`);
  if (meta.late_commit_bound !== "observed" && meta.late_commit_bound !== "overlap-only") {
    fail(`late_commit_bound missing or invalid: ${meta.late_commit_bound}`);
  }
  if (meta.kind === "incremental" && (!meta.base_captured_at || !meta.since)) fail("incremental without base_captured_at/since");
  if (shapeSha256(db) !== meta.shape_sha256) fail("table layout does not match its recorded shape hash");

  const tables = Object.keys(manifest);
  if (tables.length === 0) fail("empty manifest");
  for (const [table, e] of Object.entries(manifest)) {
    if (!hasTable(db, table)) fail(`manifest names "${table}" but the file has no such table`);
    const wantDelta = meta.kind === "incremental" && table in INCREMENTAL_TABLES;
    if (e.mode !== (wantDelta ? "delta" : "full")) fail(`"${table}" has mode ${e.mode}, expected ${wantDelta ? "delta" : "full"}`);
    const n = db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get().n;
    if (n !== e.rows) fail(`"${table}" holds ${n} rows but the manifest declares ${e.rows}`);
    if (e.mode === "delta" && !Number.isInteger(e.source_count)) fail(`delta "${table}" has no live source count`);
  }
  // A table with rows that the manifest doesn't account for means the
  // manifest is incomplete, not that the table is optional.
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN (?, ?) AND name NOT LIKE 'sqlite_%'")
    .all(META_TABLE, MANIFEST_TABLE)) {
    if (!manifest[name] && db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(name)}`).get().n > 0) {
      fail(`table "${name}" has rows but is missing from the manifest`);
    }
  }
  return { meta, manifest };
}

/**
 * Decide where an incremental starts from a VALIDATED base (validateArtifact).
 *
 * @returns {{ since: string, baseCapturedAt: string }}
 */
export function planIncremental(base, currentSchemaSha) {
  const { meta } = base;
  if (meta.schema_sha256 !== currentSchemaSha) {
    throw new Error("lib/db/schema.sqlite.sql changed since the base backup; take a full backup (schema change)");
  }
  const capturedMs = Date.parse(meta.captured_at);
  let sinceMs = capturedMs - OVERLAP_MS;
  const oldestOpen = meta.oldest_open_xact_at ? Date.parse(meta.oldest_open_xact_at) : NaN;
  if (Number.isFinite(oldestOpen) && oldestOpen < sinceMs) sinceMs = oldestOpen;
  return { since: new Date(sinceMs).toISOString(), baseCapturedAt: new Date(capturedMs).toISOString() };
}

/**
 * Write _backup_meta and _backup_manifest in one transaction, after hashing
 * the file's shape (so the hash covers data tables only).
 *
 * @param {{ exec(sql: string): void, prepare(sql: string): any }} db
 * @param {Record<string, string | null | undefined>} meta
 * @param {{ table: string, mode: "full"|"delta", rows: number, watermark?: string|null, since?: string|null, sourceCount?: number|null }[]} entries
 */
export function writeManifest(db, meta, entries) {
  const shape = shapeSha256(db);
  db.exec("BEGIN");
  try {
    db.exec(`CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(
      `CREATE TABLE ${MANIFEST_TABLE} (
         table_name TEXT PRIMARY KEY,
         mode TEXT NOT NULL CHECK (mode IN ('full', 'delta')),
         rows INTEGER NOT NULL,
         watermark_column TEXT,
         since TEXT,
         source_count INTEGER
       )`,
    );
    const putMeta = db.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
    for (const [k, v] of Object.entries({ ...meta, shape_sha256: shape })) {
      if (v !== null && v !== undefined) putMeta.run(k, String(v));
    }
    const put = db.prepare(
      `INSERT INTO ${MANIFEST_TABLE} (table_name, mode, rows, watermark_column, since, source_count) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const e of entries) {
      put.run(e.table, e.mode, e.rows, e.watermark ?? null, e.since ?? null, e.sourceCount ?? null);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Private working path for an output file; never matches backups/*.sqlite. */
export function partialPath(outPath) {
  return `${outPath}.partial`;
}

/**
 * Publish a finished working file: leave WAL mode (checkpoints into the main
 * file), close, then hard-link to outPath — which fails if outPath exists, so
 * a published backup is never overwritten — and drop the working name.
 */
export function publishPartial(db, tmpPath, outPath) {
  db.exec("PRAGMA journal_mode = DELETE;");
  db.close();
  linkSync(tmpPath, outPath);
  unlinkSync(tmpPath);
}

/** Best-effort removal of a working file and its sidecars. Never outPath. */
export function discardPartial(tmpPath) {
  for (const p of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`, `${tmpPath}-journal`]) {
    try { if (existsSync(p)) rmSync(p); } catch { /* best-effort */ }
  }
}

/**
 * Copy one table from Postgres into an open SQLite backup, in full or as a
 * delta. Wraps its own BEGIN/COMMIT. Returns the manifest entry, plus the
 * delta snapshot's capture fields when it read a delta.
 *
 * @param {(text: string, params: unknown[]) => Promise<Record<string, unknown>[]>} query
 * @param {{ exec(sql: string): void, prepare(sql: string): any }} db  A node:sqlite DatabaseSync.
 * @param {object} opts
 * @param {string} opts.table
 * @param {{ column_name: string, data_type: string }[]} opts.pgColumns  Mirrored columns only.
 * @param {string[]} opts.pkColumns
 * @param {number} [opts.chunkRows]
 * @param {string|null} [opts.since]  ISO start of the delta; null = full read.
 * @param {(stmts: { text: string, params: unknown[] }[]) => Promise<Record<string, unknown>[][]>} [opts.snapshot]
 *   Runs statements in one read-only REPEATABLE READ transaction. Required for a delta.
 * @param {{ text: string, params: unknown[] }} [opts.capture]  Clock statement (PG_CAPTURE_SQL).
 * @returns {Promise<{ table: string, mode: "full"|"delta", rows: number, watermark?: string, since?: string, sourceCount?: number, capture?: Record<string, unknown> }>}
 */
export async function exportTable(query, db, opts) {
  const {
    table,
    pgColumns,
    pkColumns,
    chunkRows = DEFAULT_CHUNK_ROWS,
    since = null,
    snapshot,
    capture = { text: PG_CAPTURE_SQL, params: [] },
  } = opts;
  const colNames = pgColumns.map((c) => c.column_name);
  const selectList = colNames.map(quoteIdent).join(", ");
  const watermark = since !== null ? INCREMENTAL_TABLES[table] ?? null : null;
  const insert = db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${selectList}) VALUES (${colNames.map(() => "?").join(", ")})`,
  );
  const insertRows = (rows) => {
    for (const row of rows) insert.run(...pgColumns.map((c) => coerce(row[c.column_name], c.data_type)));
  };

  if (!watermark) {
    let rows = 0;
    db.exec("BEGIN");
    try {
      for await (const chunk of fetchTableChunks(query, { table, selectList, selectColumns: colNames, pkColumns, chunkRows })) {
        insertRows(chunk);
        rows += chunk.length;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return { table, mode: "full", rows };
  }

  if (typeof snapshot !== "function") throw new Error(`delta read of "${table}" needs a snapshot transaction`);
  if (!pkColumns.length || !pkColumns.every((c) => colNames.includes(c)) || !colNames.includes(watermark)) {
    throw new Error(`"${table}" lacks a selectable primary key or "${watermark}" — cannot read it incrementally`);
  }
  const t = quoteIdent(table);
  let results;
  try {
    results = await snapshot([
      capture,
      {
        text: `SELECT ${selectList} FROM ${t} WHERE ${quoteIdent(watermark)} >= $1 ORDER BY ${pkColumns.map(quoteIdent).join(", ")}`,
        params: [since],
      },
      { text: `SELECT count(*) AS n FROM ${t}`, params: [] },
    ]);
  } catch (err) {
    if (isResponseTooLargeError(err)) {
      throw new Error(`"${table}" delta exceeds Neon's 64 MB single-response cap; take a full backup`);
    }
    throw err;
  }
  const [[captureRow], deltaRows, [countRow]] = results;
  db.exec("BEGIN");
  try {
    insertRows(deltaRows);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    table,
    mode: "delta",
    rows: deltaRows.length,
    watermark,
    since,
    sourceCount: Number(countRow.n),
    capture: captureRow,
  };
}
