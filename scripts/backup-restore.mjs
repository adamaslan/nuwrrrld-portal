#!/usr/bin/env node
/**
 * backup-restore.mjs — rebuild one complete SQLite snapshot from a full
 * backup plus the incremental backups taken after it (in order).
 *
 *   node scripts/backup-restore.mjs --out=backups/restored.sqlite \
 *     backups/full.sqlite backups/inc-1.sqlite backups/inc-2.sqlite
 *
 * Reads local files only; never touches Neon. Every file is first checked by
 * validateArtifact() (kind, filter state, schema shape, manifest modes,
 * actual row counts, mandatory delta counts). Then restore refuses, rather
 * than producing a quietly incomplete copy, when:
 *   - the first file is not a full backup;
 *   - a link is missing or out of order (each incremental names the
 *     captured_at of the backup it was based on);
 *   - lib/db/schema.sqlite.sql or the table layout changed in the chain;
 *   - the links do not cover the same set of tables;
 *   - a delta table's restored row count differs from the live count read in
 *     the same snapshot as its delta (missing rows, or rows deleted at the
 *     source that the delta could not remove — take a full backup).
 * The restored file records late_commit_guarantee: "overlap-only" when any
 * base in the chain could not see every open transaction (see
 * backup-incremental.mjs, "Late commits"). Built in a staging directory
 * owned by this invocation and published by a no-overwrite hard link; never
 * overwrites --out.
 */
import { copyFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  META_TABLE,
  MANIFEST_TABLE,
  BACKUP_FORMAT_VERSION,
  validateArtifact,
  createStaging,
  publishStaged,
  discardStaging,
} from "./backup-incremental.mjs";

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function readLink(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { path, ...validateArtifact(db, path) };
  } finally {
    db.close();
  }
}

/** Validate chain ordering over already-validated links. Exported for tests. */
export function validateChain(links) {
  if (links.length === 0) throw new Error("no backup files given");
  const [base] = links;
  if (base.meta.kind !== "full") {
    throw new Error(`${base.path}: first file must be a full backup (kind=${base.meta.kind ?? "none"})`);
  }
  const baseTables = Object.keys(base.manifest).sort().join(",");
  for (const link of links) {
    if (link.meta.schema_sha256 !== base.meta.schema_sha256 || link.meta.shape_sha256 !== base.meta.shape_sha256) {
      throw new Error(`${link.path}: schema changed since ${base.path}; restore from a newer full backup`);
    }
    if (Object.keys(link.manifest).sort().join(",") !== baseTables) {
      throw new Error(`${link.path}: covers a different set of tables than ${base.path}`);
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
  }
}

/**
 * Apply `paths` (full first, then incrementals in order) into a new file at
 * `outPath`. Returns per-table row counts of the restored copy.
 *
 * @param {string[]} paths
 * @param {string} outPath
 * @returns {Record<string, number>}
 */
export function restoreChain(paths, outPath) {
  if (existsSync(outPath)) throw new Error(`${outPath} already exists — refusing to overwrite`);
  const links = paths.map(readLink);
  validateChain(links);

  const staging = createStaging(outPath);
  let out;
  try {
    copyFileSync(paths[0], staging.path);
    out = new DatabaseSync(staging.path);
  } catch (err) {
    discardStaging(staging);
    throw err;
  }
  try {
    out.exec("PRAGMA foreign_keys = OFF;");
    for (const link of links.slice(1)) {
      out.exec(`ATTACH DATABASE '${link.path.replace(/'/g, "''")}' AS inc`);
      out.exec("BEGIN");
      try {
        for (const [table, entry] of Object.entries(link.manifest)) {
          const t = quoteIdent(table);
          if (entry.mode !== "delta") {
            out.exec(`DELETE FROM main.${t}`);
            out.exec(`INSERT INTO main.${t} SELECT * FROM inc.${t}`);
            continue;
          }
          out.exec(`INSERT OR REPLACE INTO main.${t} SELECT * FROM inc.${t}`);
          const n = out.prepare(`SELECT count(*) AS n FROM main.${t}`).get().n;
          if (n < entry.source_count) {
            throw new Error(
              `${link.path}: "${table}" restored ${n} rows but the source had ${entry.source_count} — ` +
              `${entry.source_count - n} row(s) missing from the chain; take a full backup`,
            );
          }
          if (n > entry.source_count) {
            throw new Error(
              `${link.path}: "${table}" restored ${n} rows but the source had ${entry.source_count} — ` +
              `${n - entry.source_count} stale row(s) deleted at the source since the base; take a full backup`,
            );
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

    // Each delta's coverage depends on its BASE's late-commit bound.
    const guarantee = links.slice(0, -1).some((l) => l.meta.late_commit_bound !== "observed")
      ? "overlap-only"
      : "observed";
    const last = links[links.length - 1];
    out.exec("BEGIN");
    out.exec(`DROP TABLE IF EXISTS ${META_TABLE}`);
    out.exec(`DROP TABLE IF EXISTS ${MANIFEST_TABLE}`);
    out.exec(`CREATE TABLE ${META_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const put = out.prepare(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`);
    put.run("kind", "restored");
    put.run("captured_at", last.meta.captured_at);
    put.run("format_version", BACKUP_FORMAT_VERSION);
    put.run("schema_sha256", last.meta.schema_sha256);
    put.run("chain_length", String(links.length));
    put.run("late_commit_guarantee", guarantee);
    out.exec("COMMIT");

    out.exec("PRAGMA foreign_keys = ON;");
    const violations = out.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) {
      throw new Error(`${violations.length} foreign-key violation(s) in the restored copy: ${JSON.stringify(violations.slice(0, 5))}`);
    }
    const integrity = out.prepare("PRAGMA integrity_check").get();
    if (Object.values(integrity)[0] !== "ok") throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);

    /** @type {Record<string, number>} */
    const counts = {};
    for (const table of Object.keys(last.manifest)) {
      counts[table] = out.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get().n;
    }
    publishStaged(out, staging, outPath);
    return counts;
  } catch (err) {
    try { out.close(); } catch { /* already closed */ }
    discardStaging(staging);
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
  const outPath = outArg.slice("--out=".length);
  try {
    const counts = restoreChain(files, outPath);
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    console.log(`Restored ${files.length} file(s), ${Object.keys(counts).length} tables, ${total} rows -> ${outPath}`);
  } catch (err) {
    console.error(`✖ Restore failed: ${err.message}`);
    process.exit(1);
  }
}
