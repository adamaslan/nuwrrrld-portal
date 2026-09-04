---
date: 2026-09-04
type: entity
tags: [database, sqlite, neon, testing, ci]
sources: [../../scripts/gen-sqlite-schema.mjs, ../../test/db-parity/sqlite-sql-tag.ts, ../../__tests__/db-parity/lib-db-modules.test.ts, ../../__tests__/db-parity/README.md, ../openrouter-migration-and-db-parity-plan.md, PR#105]
---

# Entity: DB Parity Suite (`scripts/gen-sqlite-schema.mjs` + `test/db-parity/`)

Phases 7-8 of `docs/openrouter-migration-and-db-parity-plan.md`. Two pieces
that answer "does the SQLite backup path actually run the same code as
Neon?" — a question [[entity-sqlite-backup]] could only gesture at before
(its Known-failure #3 named the risk without auditing it).

## What it is

- **`scripts/gen-sqlite-schema.mjs`** (Phase 7) — derives
  `lib/db/schema.sqlite.sql` from `lib/db/schema.sql` by regex rewrite
  (identity PK, `uuid`, `jsonb`, `timestamptz`, `text[]`, `inet`, `boolean`,
  `::casts`, the `corpus_chunks.tsv` GENERATED/GIN construct), replacing a
  hand-maintained parallel file that could silently drift. `--check` mode is
  what `npm run db:check-sqlite-schema` runs in CI (`db-schema-parity` job).
- **`test/db-parity/sqlite-sql-tag.ts`** (Phase 8) — a `node:sqlite`-backed
  object matching the two call shapes `lib/*-db.ts` modules use against
  `lib/db.ts`'s Neon `sql` export: `` sql`...` `` tagged-template and
  `sql.query(text, params)` positional. Translates the Postgres idioms this
  codebase's query strings actually contain: `::casts`, two `now() - interval`
  TTL forms, `$N` positional params (reordered to match SQLite's strict
  text-order `?` binding — see Known failures below), and jsonb
  auto-deserialization (best-effort `JSON.parse` on `TEXT` values that look
  like `{...}`/`[...]`, since `@neondatabase/serverless` deserializes jsonb
  columns automatically and SQLite can't).
- **`__tests__/db-parity/lib-db-modules.test.ts`** — for 10 of the 14
  `lib/*-db.ts` modules, dynamically imports the module fresh with
  `@/lib/db` mocked to the SQLite adapter (via `vi.doMock` + `vi.resetModules`)
  and runs its real exported functions — not shape assertions, actual
  round-trips (insert → read back, upsert twice → confirm no duplicate,
  quota increment → confirm arithmetic). A `describe.skipIf(!DATABASE_URL)`
  companion run repeats the same calls against real Neon when CI sets
  `NEON_BRANCH_DATABASE_URL`.

## Where used

- **CI:** `.github/workflows/ci.yml`'s `db-schema-parity` job, Node 22
  (separate from the main `test` job's Node 20 — `node:sqlite` needs 22.5+).
- **Local:** `npm run db:gen-sqlite-schema`, `npm run db:check-sqlite-schema`,
  `npm run test:db-parity`.

## Known failures

1. **Not all 14 `lib/*-db.ts` modules are covered.**
   `lib/followed-tickers-db.ts`, `lib/live-price-db.ts`,
   `lib/ticker-cards-db.ts` (all use `unnest($1::type[], …) AS t(cols)` bulk
   upserts or `= ANY($1::type[])`, neither of which SQLite has a builtin
   for) and `precomputed-ai-db.ts`'s `listWatchlistSubjects`
   (`string_agg(DISTINCT … ORDER BY …)`, which SQLite's `group_concat()`
   can't express directly) are deliberately excluded rather than faked — see
   `__tests__/db-parity/README.md` for the specific translation each would
   need.
2. **The suite caught two real bugs on first run, both fixed in the same
   PR:**
   - `council-db.ts`'s `createSession()` relied on Postgres's
     `DEFAULT gen_random_uuid()` on `council_sessions.id` — a server-side
     default the generated SQLite schema has no equivalent for (the uuid PK
     rule drops the default entirely, on the theory the app should supply
     it). Fixed by generating the id with `crypto.randomUUID()` app-side,
     which now works identically on both engines.
   - The adapter's first pass converted `$1`/`$2` to `?` with a naive
     text-order replace, which silently swapped bound values whenever a
     query referenced its params out of numeric order (found via
     `privacy-requests-db.ts`'s `resolvePrivacyRequest`:
     `SET status = $2, resolved_at = now() WHERE id = $1` — `$2` appears
     first in the text but should bind second). Fixed by reordering the
     params array to match SQLite's strict text-order `?` binding instead of
     rewriting text only.
3. **jsonb auto-parse is a heuristic, not a schema-aware decode.** The
   adapter attempts `JSON.parse` on any `TEXT` value starting with `{`, `[`,
   or `"`, rather than knowing which columns are actually `jsonb` in
   `schema.sql` (that information is discarded once `schema.sqlite.sql` maps
   them all to plain `TEXT`). A plain-text column whose value coincidentally
   looks like JSON (starts with a JSON-parseable string) would be
   mis-decoded; none of the 10 covered modules currently have one, but a
   future column could.

## Open questions

- ❓ Should the `unnest()`/`ANY(array)` translation (Known failure #1) be
  its own follow-up PR, given it's the harder half of what a genuinely
  swappable Neon/SQLite driver would need (see
  [[entity-sqlite-backup]]'s Known failure #3)?
- ❓ Is the jsonb heuristic (Known failure #3) worth replacing with a real
  column-type map carried alongside `schema.sqlite.sql` (e.g. a sibling
  `schema.sqlite.columns.json` the generator also emits), or is the current
  best-effort parse good enough given the suite's actual current coverage?

## See also

- [[entity-sqlite-backup]] — the backup/export path this suite validates against
- `../openrouter-migration-and-db-parity-plan.md` — Phases 7-8, the source plan
- [[incident-2026-09-04-precompute-ai-double-schedule]] — an unrelated finding from the same PR's Phase 5/6 audit pass
