#!/usr/bin/env node
// Generates lib/db/schema.sqlite.sql from lib/db/schema.sql.
//
// Phase 7 of docs/openrouter-migration-and-db-parity-plan.md: the SQLite
// schema used to be hand-maintained in parallel with the Postgres one and
// could silently drift. This script derives it instead, so a `schema.sql`
// edit that isn't reflected fails CI (see `npm run db:check-sqlite-schema`
// wired into ci.yml) rather than surfacing as a runtime backup-restore bug.
//
// This is a targeted rewrite of the Postgres-isms this repo's schema.sql
// actually uses, not a general Postgres→SQLite dialect translator. If a new
// construct is added to schema.sql that this script doesn't know how to
// translate, `npm run db:gen-sqlite-schema` will still emit *something* —
// review the diff by hand and extend the RULES/DROP_STATEMENT_PATTERNS below.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE_PATH = path.join(REPO_ROOT, "lib/db/schema.sql");
const OUTPUT_PATH = path.join(REPO_ROOT, "lib/db/schema.sqlite.sql");

const GENERATED_HEADER = `-- GENERATED — do not edit by hand.
-- Source of truth: lib/db/schema.sql (Postgres/Neon).
-- Regenerate with: npm run db:gen-sqlite-schema
-- CI (ci.yml) fails the build if this file drifts from that command's output.
--
-- This file is the SQLite dialect used by scripts/backup-to-sqlite.mjs and
-- the local/backup restore path. See docs/openrouter-migration-and-db-parity-plan.md
-- Phase 7 for why it is generated instead of hand-maintained.

PRAGMA foreign_keys = ON;

`;

/**
 * Statements (matched whole, case-insensitive, across newlines) that have no
 * SQLite equivalent and are dropped entirely rather than rewritten:
 *   - CREATE OR REPLACE FUNCTION ... — SQLite has no user-defined SQL
 *     functions in schema DDL. The one caller (corpus_chunks.tsv) is
 *     rewritten below to a plain column instead of a GENERATED one.
 *   - The one-time `DELETE FROM analyze_cache a USING analyze_cache b …`
 *     dedup migration — Postgres multi-table DELETE syntax with no SQLite
 *     equivalent. It exists to clean up rows from a table that predates a
 *     unique index; a freshly generated SQLite schema is always applied to
 *     an empty table, so the cleanup is a no-op there and safe to drop.
 */
const DROP_STATEMENT_PATTERNS = [
  /CREATE OR REPLACE FUNCTION immutable_corpus_tsvector[\s\S]*?\$\$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;/i,
  /DELETE FROM analyze_cache a USING analyze_cache b[\s\S]*?a\.generated_at < b\.generated_at;/i,
  // GIN indexes have no SQLite equivalent; corpus full-text search is a
  // Postgres-only feature for now (the backup path doesn't need search).
  /CREATE INDEX IF NOT EXISTS corpus_chunks_tsv_idx\s*\n\s*ON corpus_chunks USING GIN \(tsv\);/i,
  // These ALTER TABLE ADD COLUMN IF NOT EXISTS lines exist only to migrate
  // Postgres deployments created before the columns existed — the CREATE
  // TABLE above them already declares the columns, and SQLite's ALTER TABLE
  // doesn't support IF NOT EXISTS at all, so on a freshly generated schema
  // these are pure no-ops.
  /ALTER TABLE pending_signals ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;/i,
  /ALTER TABLE pending_signals ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now\(\);/i,
  /ALTER TABLE pending_signals ADD COLUMN IF NOT EXISTS claimed_at timestamptz;/i,
];

/**
 * Ordered regex → replacement rules applied to whatever survives the drops
 * above. Order matters: more specific patterns (e.g. an identity primary key)
 * must run before the generic type-name swap they'd otherwise also match.
 */
const RULES = [
  // Postgres type casts (`'{}'::jsonb`) have no SQLite equivalent — SQLite is
  // dynamically typed, so the cast is simply dropped. Must run before the
  // scalar type-swap rules below, or the cast target gets rewritten instead
  // of removed (e.g. `::jsonb` → `::TEXT`, which is still invalid SQLite).
  [/::\w+/g, ""],

  // Identity/serial primary keys → SQLite rowid aliasing, which is the only
  // construct that actually autoincrements.
  [/bigint\s+GENERATED ALWAYS AS IDENTITY PRIMARY KEY/gi, "INTEGER PRIMARY KEY AUTOINCREMENT"],

  // uuid primary keys generated app-side or by Postgres: SQLite has no uuid
  // type or gen_random_uuid(); store as TEXT and drop the DB-side default so
  // the app is the single source of the id (every *-db.ts insert already
  // supplies one via crypto.randomUUID() for the Postgres path — the SQLite
  // path must do the same, per Phase 8's contract-test coverage).
  [/uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/gi, "TEXT PRIMARY KEY"],
  [/\buuid\b/gi, "TEXT"],

  // Scalar type swaps.
  [/\bjsonb\b/gi, "TEXT"],
  [/\btimestamptz\b/gi, "TEXT"],
  [/\bboolean\b/gi, "INTEGER"],
  [/\binet\b/gi, "TEXT"],
  [/\bdate\b/gi, "TEXT"],
  // A text[] column's Postgres empty-array literal is '{}' (curly braces —
  // valid Postgres array syntax, NOT a JSON object). The app layer serializes
  // arrays as JSON for the SQLite path (see Phase 8 contract tests), where an
  // empty array is '[]'. Left unrewritten, an INSERT that omits one of these
  // columns would default to the literal string "{}", which JSON.parse()s as
  // an empty *object*, not an empty array — a shape mismatch the contract
  // suite is specifically meant to catch. Must run before the generic
  // text[] -> TEXT swap below, while the `text[]` token is still present to
  // anchor the match. CodeRabbit review, PR #105.
  [/text\[\](\s*NOT NULL DEFAULT\s*)'\{\}'/gi, "text[]$1'[]'"],

  // text[] (and any other []-suffixed array type) → TEXT; app layers
  // serialize arrays as JSON for the SQLite path (see Phase 8 contract tests).
  [/\btext\[\]/gi, "TEXT"],

  // now() has no SQLite equivalent; CURRENT_TIMESTAMP is the closest builtin
  // (UTC, 'YYYY-MM-DD HH:MM:SS' — good enough for a read-only backup mirror).
  [/\bnow\(\)/gi, "CURRENT_TIMESTAMP"],

  // The GENERATED tsvector column becomes a plain, ungenerated TEXT column —
  // full-text search over the backup mirror isn't a supported use case; the
  // column is kept only so downstream selects listing all columns don't break.
  [
    /tsv\s+tsvector GENERATED ALWAYS AS \(\s*\n\s*immutable_corpus_tsvector\(body, search_terms\)\s*\n\s*\) STORED,/i,
    "tsv          TEXT,",
  ],

  // bigint used for plain counters/ids (not already handled by the identity
  // rule above) → INTEGER; SQLite has no separate bigint storage class.
  [/\bbigint\b/gi, "INTEGER"],
];

function stripDroppedStatements(sql) {
  let out = sql;
  for (const pattern of DROP_STATEMENT_PATTERNS) {
    out = out.replace(pattern, "-- (dropped for SQLite: no equivalent construct — see gen-sqlite-schema.mjs)");
  }
  return out;
}

function applyRules(sql) {
  let out = sql;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function computeContent() {
  const source = readFileSync(SOURCE_PATH, "utf8");
  return GENERATED_HEADER + applyRules(stripDroppedStatements(source));
}

// --check mode: compute fresh content and diff against the committed file
// WITHOUT writing, exiting non-zero on drift. This is what ci.yml runs — see
// Phase 7's "Done when" criterion. Plain mode writes the file.
if (process.argv.includes("--check")) {
  const fresh = computeContent();
  let committed = "";
  try {
    committed = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    // missing file falls through as a drift below
  }
  if (committed !== fresh) {
    console.error(
      "lib/db/schema.sqlite.sql is stale — run `npm run db:gen-sqlite-schema` and commit the result.",
    );
    process.exit(1);
  }
  console.log("lib/db/schema.sqlite.sql is up to date.");
} else {
  writeFileSync(OUTPUT_PATH, computeContent(), "utf8");
  console.log(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
}
