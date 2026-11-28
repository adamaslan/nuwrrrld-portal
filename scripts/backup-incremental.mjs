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
 *   - every INSERT and every UPDATE sets one watermark column to now(), and
 *   - no code path deletes rows (deletes are not visible in a delta).
 * daily_bars qualifies: lib/engine-db.ts upsertBars() is its only writer, the
 * insert defaults fetched_at to now() and ON CONFLICT sets fetched_at = now(),
 * and nothing deletes from it. These do NOT qualify and stay full every run:
 *   - news_articles: modal_app.py sets corroborated = true without touching
 *     updated_at, so an updated row would be missed.
 *   - news_article_symbols: no timestamp column at all.
 *   - news_article_scores: insert-only, but rows vanish by ON DELETE CASCADE
 *     when an article is deleted, and a delta cannot see that.
 * Restore still re-checks daily_bars' row count against the live count read
 * at backup time, so an unexpected delete fails restore loudly instead of
 * leaving a stale row in the restored copy.
 *
 * Each backup file carries a _backup_meta table (kind, captured_at, schema
 * hash, since) and a _backup_manifest table (per-table mode, rows, source
 * count). scripts/backup-restore.mjs uses them to apply a chain of
 * full + incrementals and to refuse a chain with a gap or a schema change.
 */
import { createHash } from "node:crypto";
import {
  fetchTableChunks,
  isResponseTooLargeError,
  DEFAULT_CHUNK_ROWS,
  MIN_CHUNK_ROWS,
} from "./backup-pagination.mjs";

export const BACKUP_FORMAT_VERSION = "1";

/** table -> watermark column. See the header for why only daily_bars. */
export const INCREMENTAL_TABLES = Object.freeze({ daily_bars: "fetched_at" });

/**
 * How far before the base's captured_at an incremental starts reading. A
 * write whose transaction began before the base read its table but committed
 * after carries a fetched_at older than captured_at; the overlap catches it.
 * Re-read rows are idempotent on restore (INSERT OR REPLACE by primary key).
 */
export const OVERLAP_MS = 6 * 60 * 60 * 1000;

export const META_TABLE = "_backup_meta";
export const MANIFEST_TABLE = "_backup_manifest";

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

export function schemaSha256(schemaSql) {
  return createHash("sha256").update(schemaSql).digest("hex");
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
 * Read the base backup's metadata and decide where an incremental starts.
 * Throws instead of guessing when the base can't anchor a safe delta.
 *
 * @param {{ kind?: string, captured_at?: string, schema_sha256?: string, format_version?: string }} baseMeta
 * @param {string} currentSchemaSha
 * @returns {{ since: string, baseCapturedAt: string }}
 */
export function planIncremental(baseMeta, currentSchemaSha) {
  if (!baseMeta || !baseMeta.captured_at) {
    throw new Error("base backup has no _backup_meta.captured_at — it predates incremental support; take a full backup first");
  }
  if (baseMeta.format_version !== BACKUP_FORMAT_VERSION) {
    throw new Error(`base backup format ${baseMeta.format_version ?? "(none)"} != ${BACKUP_FORMAT_VERSION}; take a full backup`);
  }
  if (baseMeta.schema_sha256 !== currentSchemaSha) {
    throw new Error("lib/db/schema.sqlite.sql changed since the base backup; take a full backup (schema change)");
  }
  const capturedMs = Date.parse(baseMeta.captured_at);
  if (!Number.isFinite(capturedMs)) {
    throw new Error(`base captured_at is not a timestamp: ${baseMeta.captured_at}`);
  }
  return {
    since: new Date(capturedMs - OVERLAP_MS).toISOString(),
    baseCapturedAt: new Date(capturedMs).toISOString(),
  };
}

/** Read a backup file's _backup_meta as a plain object ({} if absent). */
export function readMeta(db) {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(META_TABLE);
  if (!has) return {};
  const out = {};
  for (const r of db.prepare(`SELECT key, value FROM ${META_TABLE}`).all()) out[r.key] = r.value;
  return out;
}

/** Read a backup file's _backup_manifest keyed by table name ({} if absent). */
export function readManifest(db) {
  const has = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(MANIFEST_TABLE);
  if (!has) return {};
  const out = {};
  for (const r of db.prepare(`SELECT * FROM ${MANIFEST_TABLE}`).all()) out[r.table_name] = r;
  return out;
}

/**
 * Write _backup_meta and _backup_manifest into a backup file.
 *
 * @param {{ exec(sql: string): void, prepare(sql: string): any }} db  A node:sqlite DatabaseSync.
 * @param {Record<string, string>} meta
 * @param {{ table: string, mode: "full"|"delta", rows: number, watermark?: string|null, since?: string|null, sourceCount?: number|null }[]} entries
 */
export function writeManifest(db, meta, entries) {
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
  for (const [k, v] of Object.entries(meta)) putMeta.run(k, String(v));
  const put = db.prepare(
    `INSERT INTO ${MANIFEST_TABLE} (table_name, mode, rows, watermark_column, since, source_count) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const e of entries) {
    put.run(e.table, e.mode, e.rows, e.watermark ?? null, e.since ?? null, e.sourceCount ?? null);
  }
}

/**
 * Async generator yielding rows whose watermark is at or after `since`, one
 * chunk at a time. Keyset-paginated over the PRIMARY KEY (stable while rows
 * are updated: an update keeps its key, so it is either read now or picked up
 * by the next run's overlap). Same adaptive halving as fetchTableChunks.
 */
export async function* fetchChangedChunks(query, opts) {
  const {
    table,
    selectList,
    selectColumns,
    pkColumns = [],
    watermark,
    since,
    chunkRows = DEFAULT_CHUNK_ROWS,
    minChunkRows = MIN_CHUNK_ROWS,
  } = opts;
  if (!Number.isInteger(chunkRows) || chunkRows < 1) {
    throw new Error(`chunkRows must be a positive integer, got ${chunkRows}`);
  }
  if (!pkColumns.length || !pkColumns.every((c) => selectColumns.includes(c))) {
    throw new Error(`"${table}" has no selectable PRIMARY KEY — cannot read it incrementally`);
  }
  if (!selectColumns.includes(watermark)) {
    throw new Error(`"${table}" has no watermark column "${watermark}" — cannot read it incrementally`);
  }
  const keyList = pkColumns.map(quoteIdent).join(", ");
  let size = chunkRows;
  let after = null;

  for (;;) {
    let rows;
    for (;;) {
      const params = [since];
      let where = `WHERE ${quoteIdent(watermark)} >= $1`;
      if (after) {
        const rhs = pkColumns.map((_, i) => `$${i + 2}`).join(", ");
        where += ` AND (${keyList}) > (${rhs})`;
        params.push(...after);
      }
      const text =
        `SELECT ${selectList} FROM ${quoteIdent(table)} ${where} ` +
        `ORDER BY ${keyList} LIMIT ${size}`;
      try {
        rows = await query(text, params);
        break;
      } catch (err) {
        if (isResponseTooLargeError(err) && size > minChunkRows) {
          const next = Math.max(minChunkRows, Math.floor(size / 2));
          console.warn(
            `  ⚠ "${table}" delta chunk of ${size} rows hit Neon's 64 MB response cap — retrying at ${next}`,
          );
          size = next;
          continue;
        }
        throw err;
      }
    }

    if (rows.length === 0) return;
    yield rows;
    if (rows.length < size) return;
    const last = rows[rows.length - 1];
    after = pkColumns.map((c) => last[c]);
  }
}

/** Live row count, recorded so restore can detect deletes in a delta table. */
export async function countRows(query, table) {
  const rows = await query(`SELECT count(*) AS n FROM ${quoteIdent(table)}`, []);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Copy one table from Postgres into an open SQLite backup, in full or as a
 * delta. The caller owns the transaction-free SQLite handle; this wraps its
 * own BEGIN/COMMIT. Returns the manifest entry for the table.
 *
 * @param {(text: string, params: unknown[]) => Promise<Record<string, unknown>[]>} query
 * @param {{ exec(sql: string): void, prepare(sql: string): any }} db  A node:sqlite DatabaseSync.
 * @param {object} opts
 * @param {string} opts.table
 * @param {{ column_name: string, data_type: string }[]} opts.pgColumns  Mirrored columns only.
 * @param {string[]} opts.pkColumns
 * @param {number} [opts.chunkRows]
 * @param {string|null} [opts.since]  ISO start of the delta; null = full read.
 * @returns {Promise<{ table: string, mode: "full"|"delta", rows: number, watermark?: string, since?: string, sourceCount?: number }>}
 */
export async function exportTable(query, db, opts) {
  const { table, pgColumns, pkColumns, chunkRows = DEFAULT_CHUNK_ROWS, since = null } = opts;
  const colNames = pgColumns.map((c) => c.column_name);
  const selectList = colNames.map(quoteIdent).join(", ");
  const watermark = since !== null ? INCREMENTAL_TABLES[table] ?? null : null;
  const insert = db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${selectList}) VALUES (${colNames.map(() => "?").join(", ")})`,
  );
  const chunks = watermark
    ? fetchChangedChunks(query, { table, selectList, selectColumns: colNames, pkColumns, watermark, since, chunkRows })
    : fetchTableChunks(query, { table, selectList, selectColumns: colNames, pkColumns, chunkRows });

  let rows = 0;
  db.exec("BEGIN");
  try {
    for await (const chunk of chunks) {
      for (const row of chunk) insert.run(...pgColumns.map((c) => coerce(row[c.column_name], c.data_type)));
      rows += chunk.length;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (!watermark) return { table, mode: "full", rows };
  // Counted after the delta read: a row inserted in between makes the count
  // larger than the restored copy, so restore fails safe instead of passing.
  const sourceCount = await countRows(query, table);
  return { table, mode: "delta", rows, watermark, since, sourceCount };
}
