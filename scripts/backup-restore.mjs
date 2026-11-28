#!/usr/bin/env node
/**
 * backup-restore.mjs — rebuild one complete SQLite snapshot from a full
 * backup plus the incremental backups taken after it (in order).
 *
 *   node scripts/backup-restore.mjs --out=backups/restored.sqlite \
 *     backups/full.sqlite backups/inc-1.sqlite backups/inc-2.sqlite
 *
 * Reads local files only; never touches Neon. Refuses, rather than producing
 * a quietly incomplete copy, when:
 *   - the first file is not a full backup, or any file is a filtered
 *     (--tables / --exclude) backup;
 *   - a link is missing or out of order (each incremental names the
 *     captured_at of the backup it was based on);
 *   - lib/db/schema.sqlite.sql changed somewhere in the chain;
 *   - a table present in the base is missing from a later link;
 *   - a delta table's restored row count differs from the live count read at
 *     backup time (a delete the delta could not see — take a full backup).
 * Never overwrites --out.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { META_TABLE, MANIFEST_TABLE, BACKUP_FORMAT_VERSION, readMeta, readManifest } from "./backup-incremental.mjs";

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function readLink(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { path, meta: readMeta(db), manifest: readManifest(db) };
  } finally {
    db.close();
  }
}

/** Validate a chain's metadata without opening the output. Exported for tests. */
export function validateChain(links) {
  if (links.length === 0) throw new Error("no backup files given");
  const [base] = links;
  if (base.meta.kind !== "full") {
    throw new Error(`${base.path}: first file must be a full backup (kind=${base.meta.kind ?? "none"})`);
  }
  for (const link of links) {
    if (link.meta.format_version !== BACKUP_FORMAT_VERSION) {
      throw new Error(`${link.path}: unsupported backup format ${link.meta.format_version ?? "(none)"}`);
    }
    if (link.meta.filtered === "1") {
      throw new Error(`${link.path}: filtered (--tables/--exclude) backups cannot be part of a restore chain`);
    }
    if (link.meta.schema_sha256 !== base.meta.schema_sha256) {
      throw new Error(`${link.path}: schema changed since ${base.path}; restore from a newer full backup`);
    }
  }
  for (let i = 1; i < links.length; i++) {
    const prev = links[i - 1];
    const link = links[i];
    if (link.meta.kind !== "incremental") {
      throw new Error(`${link.path}: expected an incremental backup after ${prev.path} (kind=${link.meta.kind})`);
    }
    if (link.meta.base_captured_at !== prev.meta.captured_at) {
      throw new Error(
        `${link.path}: was based on the backup captured at ${link.meta.base_captured_at}, ` +
        `but the previous file was captured at ${prev.meta.captured_at} — a link is missing or out of order`,
      );
    }
    for (const table of Object.keys(prev.manifest)) {
      if (!link.manifest[table]) throw new Error(`${link.path}: table "${table}" missing from this link`);
    }
  }
}

/**
 * Apply `paths` (full first, then incrementals in order) into a new file at
 * `outPath`. Returns per-table row counts of the restored copy.
 */
export function restoreChain(paths, outPath) {
  if (existsSync(outPath)) throw new Error(`${outPath} already exists — refusing to overwrite`);
  const links = paths.map(readLink);
  validateChain(links);

  copyFileSync(paths[0], outPath);
  const out = new DatabaseSync(outPath);
  try {
    out.exec("PRAGMA foreign_keys = OFF;");
    for (const link of links.slice(1)) {
      out.exec(`ATTACH DATABASE '${link.path.replace(/'/g, "''")}' AS inc`);
      out.exec("BEGIN");
      try {
        for (const [table, entry] of Object.entries(link.manifest)) {
          const t = quoteIdent(table);
          if (entry.mode === "full") {
            out.exec(`DELETE FROM main.${t}`);
            out.exec(`INSERT INTO main.${t} SELECT * FROM inc.${t}`);
          } else {
            out.exec(`INSERT OR REPLACE INTO main.${t} SELECT * FROM inc.${t}`);
            const n = out.prepare(`SELECT count(*) AS n FROM main.${t}`).get().n;
            if (entry.source_count !== null && n !== entry.source_count) {
              throw new Error(
                `${link.path}: "${table}" restored ${n} rows but the source had ${entry.source_count} — ` +
                `rows were deleted since the base, which a delta cannot carry; take a full backup`,
              );
            }
          }
        }
        out.exec("COMMIT");
      } catch (err) {
        out.exec("ROLLBACK");
        throw err;
      } finally {
        out.exec("DETACH DATABASE inc");
      }
    }

    const last = links[links.length - 1];
    out.exec(`DROP TABLE IF EXISTS ${META_TABLE}`);
    out.exec(`DROP TABLE IF EXISTS ${MANIFEST_TABLE}`);
    out.exec(`CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const put = out.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
    put.run("kind", "restored");
    put.run("captured_at", last.meta.captured_at);
    put.run("format_version", BACKUP_FORMAT_VERSION);
    put.run("schema_sha256", last.meta.schema_sha256);
    put.run("chain_length", String(links.length));

    out.exec("PRAGMA foreign_keys = ON;");
    const violations = out.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) {
      throw new Error(`${violations.length} foreign-key violation(s) in the restored copy: ${JSON.stringify(violations.slice(0, 5))}`);
    }
    const integrity = out.prepare("PRAGMA integrity_check").get();
    if (Object.values(integrity)[0] !== "ok") throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);

    const counts = {};
    for (const table of Object.keys(last.manifest)) {
      counts[table] = out.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get().n;
    }
    out.close();
    return counts;
  } catch (err) {
    try { out.close(); } catch { /* already closed */ }
    for (const stale of [outPath, `${outPath}-wal`, `${outPath}-shm`]) {
      try { if (existsSync(stale)) rmSync(stale); } catch { /* best-effort */ }
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith("--out="));
  const files = args.filter((a) => !a.startsWith("--"));
  if (!outArg || files.length === 0) {
    console.error("usage: node scripts/backup-restore.mjs --out=<new.sqlite> <full.sqlite> [incremental.sqlite ...]");
    process.exit(1);
  }
  try {
    const counts = restoreChain(files, outArg.slice("--out=".length));
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    console.log(`Restored ${files.length} file(s), ${Object.keys(counts).length} tables, ${total} rows -> ${outArg.slice(6)}`);
  } catch (err) {
    console.error(`✖ Restore failed: ${err.message}`);
    process.exit(1);
  }
}
