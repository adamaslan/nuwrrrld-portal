// Phase 8 of docs/openrouter-migration-and-db-parity-plan.md.
//
// A drop-in stand-in for lib/db.ts's Neon `sql` default export, backed by an
// in-memory SQLite DB (node:sqlite) built from the generated
// lib/db/schema.sqlite.sql. lib/*-db.ts modules import `sql` and call it
// exactly two ways — `` sql`...` `` (tagged template) and `sql.query(text,
// params)` (positional `$1` params) — so this file replicates both call
// shapes and rewrites the Postgres-only SQL fragments the query strings
// actually use into SQLite equivalents.
//
// This is NOT a general Postgres→SQLite SQL translator. It only handles the
// specific constructs present in this repo's lib/*-db.ts modules today:
// `::type` casts, the two `now() - interval` TTL idioms, and `now()` itself.
// `unnest(...)`, `= ANY(array)`, and `string_agg(DISTINCT ...)` are NOT
// translated — modules that use them (followed-tickers-db.ts, live-price-db.ts,
// ticker-cards-db.ts, and precomputed-ai-db.ts's listWatchlistSubjects) are
// intentionally excluded from the contract suite; see
// __tests__/db-parity/README.md for that gap and why it's tracked separately
// rather than faked.

import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, "../../lib/db/schema.sqlite.sql");
const PG_SCHEMA_PATH = path.resolve(__dirname, "../../lib/db/schema.sql");

export type SqlRow = Record<string, unknown>;

/**
 * Column names declared `jsonb` or `text[]` anywhere in the canonical Postgres
 * schema — the only columns SQLite's TEXT-backed mirror should ever attempt to
 * JSON.parse() back into an object/array. Derived from lib/db/schema.sql
 * itself (not hand-copied) so it can't silently drift as columns are added.
 *
 * Global by column name, not table-qualified: this file has no table context
 * at the point a row comes back (see reviveJsonColumns below), only the row's
 * own keys. The one same-name collision across tables (`tokens`: jsonb in
 * ticker_cards, `int` in nuai_usage) is harmless here — reviveJsonColumns only
 * ever attempts a *string* value, and nuai_usage.tokens is never a string.
 */
const JSON_COLUMN_NAMES: ReadonlySet<string> = (() => {
  const src = readFileSync(PG_SCHEMA_PATH, "utf8");
  const names = new Set<string>();
  const re = /^\s*(\w+)\s+(?:jsonb|text\[\])\b/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) names.add(m[1]);
  return names;
})();

/** Loads the generated SQLite schema into a fresh in-memory DB. */
export function loadSchema(db: DatabaseSync): void {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schema);
}

/**
 * Rewrites a query string (already using `?` placeholders) from
 * Postgres-isms to SQLite-compatible SQL. Order matters: casts must strip
 * before the interval patterns match, since `::interval` is part of one of
 * them.
 */
function rewriteSql(text: string): string {
  let out = text;

  // `now() - (${n} || ' minutes')::interval` → cast strips first, leaving
  // `now() - (? || ' minutes')`.
  out = out.replace(/::\w+(\[\])?/g, "");

  // Two TTL idioms this codebase uses, both meaning "generated_at within the
  // last N minutes". Rewritten to SQLite's datetime() modifier form.
  out = out.replace(
    /now\(\)\s*-\s*\(\s*\?\s*\*\s*interval\s*'1 minute'\s*\)/gi,
    "datetime('now', '-' || ? || ' minutes')",
  );
  out = out.replace(
    /now\(\)\s*-\s*\(\s*\?\s*\|\|\s*'\s*minutes'\s*\)/gi,
    "datetime('now', '-' || ? || ' minutes')",
  );

  // Any remaining bare now() (not part of the interval idioms above, e.g.
  // `expires_at > now()`, `VALUES (..., now(), ...)`) → CURRENT_TIMESTAMP,
  // which SQLite compares/stores as the same 'YYYY-MM-DD HH:MM:SS' text form
  // schema.sqlite.sql already uses for every timestamptz column.
  out = out.replace(/\bnow\(\)/gi, "CURRENT_TIMESTAMP");

  return out;
}

/**
 * Converts Postgres positional `$1, $2, …` placeholders (which may appear
 * out of numeric order in the text — e.g.
 * `SET status = $2, resolved_at = now() WHERE id = $1`) to SQLite `?`, which
 * binds strictly by text order. Reorders the params array to match, rather
 * than a naive text-only `$N → ?` replace that would silently swap bound
 * values whenever a query references its params out of order.
 */
function positionalToQuestionMarks(text: string, params: unknown[]): { text: string; params: unknown[] } {
  const reordered: unknown[] = [];
  const rewritten = text.replace(/\$(\d+)/g, (_match, n: string) => {
    reordered.push(params[Number(n) - 1]);
    return "?";
  });
  return { text: rewritten, params: reordered };
}

/**
 * @neondatabase/serverless deserializes `jsonb` columns into JS
 * objects/arrays automatically — callers across lib/*-db.ts rely on this
 * (e.g. `rows[0].payload as HoldFoldPayload`, no JSON.parse). Our generated
 * schema.sqlite.sql maps `jsonb`/`text[]` to plain `TEXT`, so SQLite hands
 * back the raw JSON string instead. This restores the same shape — but only
 * for columns JSON_COLUMN_NAMES identifies as actually jsonb/array in the
 * canonical Postgres schema, never by sniffing whether a value merely looks
 * JSON-shaped. Value-shape sniffing (the previous approach) would parse a
 * plain TEXT value that happens to start with `{`/`[`/`"` — masking exactly
 * the kind of SQLite/Postgres result-shape mismatch this contract suite
 * exists to catch. CodeRabbit review, PR #105.
 */
function reviveJsonColumns(row: SqlRow): SqlRow {
  const out: SqlRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string" && JSON_COLUMN_NAMES.has(key)) {
      try {
        out[key] = JSON.parse(value);
        continue;
      } catch {
        // Declared jsonb/array but didn't parse — a real bug (bad data, or a
        // rewriteSql/insert path that didn't JSON.stringify). Surface it
        // rather than silently keeping the unparsed string, which would let
        // the contract suite pass on a row that's actually broken.
        throw new Error(`Column "${key}" is a declared jsonb/text[] column but its value did not parse as JSON: ${value}`);
      }
    }
    out[key] = value;
  }
  return out;
}

function runStatement(db: DatabaseSync, text: string, params: unknown[]): SqlRow[] {
  const stmt = db.prepare(text);
  const bound = params.map((p) => (p === undefined ? null : p));
  // node:sqlite's StatementSync.all() works for both SELECT and
  // INSERT/UPDATE ... RETURNING; for statements with no result set it
  // returns an empty array, matching the shape @neondatabase/serverless
  // returns for a write with no RETURNING.
  const rows = stmt.all(...bound) as SqlRow[];
  return rows.map(reviveJsonColumns);
}

export interface SqliteSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlRow[]>;
  query(text: string, params?: unknown[]): Promise<SqlRow[]>;
}

/** Builds the `sql` stand-in for a given in-memory SQLite DB. */
export function createSqliteSql(db: DatabaseSync): SqliteSql {
  const tag = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    const params: unknown[] = [];
    values.forEach((v, i) => {
      params.push(v);
      text += "?" + strings[i + 1];
    });
    return runStatement(db, rewriteSql(text), params);
  }) as SqliteSql;

  tag.query = async (text: string, params: unknown[] = []) => {
    const { text: reordered, params: reorderedParams } = positionalToQuestionMarks(text, params);
    return runStatement(db, rewriteSql(reordered), reorderedParams);
  };

  return tag;
}
