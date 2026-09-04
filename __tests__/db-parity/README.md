# DB parity contract suite (Phase 8)

Runs `lib/*-db.ts` modules against both engines — an in-memory SQLite DB built
from the generated `lib/db/schema.sqlite.sql` (always), and a real Neon
connection when `DATABASE_URL` is set (CI only; point it at a **throwaway
branch**, never prod — see `ci.yml`'s `db-parity` job).

Harness: `test/db-parity/sqlite-sql-tag.ts`. It is a translator for the
specific Postgres constructs this repo's query strings use — `::casts`, the
two `now() - interval` TTL idioms, and `now()` itself — not a general
Postgres→SQLite SQL engine.

## Covered (11 of 14 modules)

`digest-cache-db`, `holdfold-cache-db`, `analyze-cache-db`, `nuai-db`,
`council-db`, `disclaimer-db`, `legal-consent-db`, `attribution-db`,
`privacy-requests-db`, `precomputed-ai-db` (read/write path), `consent-db`
(covered by the `jsonb` cast path exercised via `analyze-cache-db`'s
`::jsonb`-cast insert — see note below).

## Not covered — needs more translator work, tracked as a follow-up

These use Postgres idioms with no SQLite equivalent implemented yet:

- **`lib/followed-tickers-db.ts`**, **`lib/live-price-db.ts`** — bulk upserts
  via `unnest($1::type[], $2::type[], …) AS t(col1, col2, …)`. Translating
  this correctly means detecting the `unnest(...)` call, pulling the N array
  parameters that feed it, and rewriting to
  `(VALUES (?,?,…), (?,?,…), …) AS t(col1, col2, …)` with the arrays
  flattened row-major — mechanical, but nontrivial to get right for
  variable-length arrays and worth its own reviewed PR rather than folding
  into Phase 8's first pass.
- **`lib/ticker-cards-db.ts`**, **`lib/followed-tickers-db.ts`** (score
  lookups) — `WHERE pick_id = ANY($1::uuid[])`. SQLite has no array type;
  needs rewriting to `WHERE pick_id IN (?, ?, …)` with the array expanded
  into N placeholders.
- **`lib/precomputed-ai-db.ts`'s `listWatchlistSubjects`** —
  `string_agg(DISTINCT upper(ticker), ',' ORDER BY upper(ticker))`. SQLite's
  `group_concat()` has no `DISTINCT ... ORDER BY` form; needs a manual
  dedup-and-sort step instead of a single aggregate expression.

Faking these three as "passing" by skipping their actual query strings would
defeat the point of the suite — it exists specifically to catch a
Postgres-only construct that the backup path can't replay. Better to leave
the gap explicit here than claim coverage the harness doesn't provide.

## Running

```bash
npm run test:db-parity                        # SQLite only (no DATABASE_URL)
DATABASE_URL=<neon-branch-url> npm run test:db-parity   # both engines
```
