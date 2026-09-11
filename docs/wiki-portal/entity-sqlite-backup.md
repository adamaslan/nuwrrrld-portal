---
date: 2026-09-04
type: entity
tags: [database, backup, sqlite, neon, offline]
sources: [../../scripts/backup-to-sqlite.mjs, ../../scripts/gen-sqlite-schema.mjs, ../../lib/db/schema.sqlite.sql, ../../.github/workflows/backup-to-sqlite.yml, ../local-sqlite-backup-and-offline-dev.md, ../sqlite-backup-code.md, ../openrouter-migration-and-db-parity-plan.md, PR#98, PR#105]
---

# Entity: SQLite Backup (`scripts/backup-to-sqlite.mjs`)

A point-in-time snapshot exporter: reads every table in the live Neon database
(`DATABASE_URL`) and writes it into a local SQLite file, using Node's
**built-in** `node:sqlite` (Node 22.5+, experimental) — no new dependency, no
native build step.

## What it is

- **`scripts/backup-to-sqlite.mjs`** — the exporter. Introspects
  `information_schema.columns` live (not a hardcoded type map) so it can't
  silently drift from [[entity-openrouter-client]]-style schema rot; coerces
  each Postgres value (jsonb/arrays → JSON text, `timestamptz`/`date` → ISO
  strings, `boolean` → 0/1, `numeric` → `REAL`) before inserting. A live
  Postgres column with no counterpart in the SQLite mirror **aborts the run**
  (rather than being quietly omitted) unless it's on the explicit
  `EXPECTED_UNMIRRORED_COLUMNS` allow-list (currently just `corpus_chunks.tsv`),
  so a column added to `schema.sql` but not `schema.sqlite.sql` can't slip out
  of the backup unnoticed. On any failure after the output file is opened, the
  partial `.sqlite` + its WAL/SHM sidecars are deleted so the next run can retry.
- **`lib/db/schema.sqlite.sql`** — as of PR #105, **generated** by
  `scripts/gen-sqlite-schema.mjs` from `lib/db/schema.sql` rather than
  hand-maintained; `npm run db:check-sqlite-schema` fails CI
  (`db-schema-parity` job) if the two drift. Same translation rules as
  before (identity PK → `INTEGER PRIMARY KEY AUTOINCREMENT`, `uuid` → `TEXT`,
  `jsonb`/`timestamptz`/`text[]`/`inet`/`boolean` → `TEXT`/`INTEGER`,
  `::casts` stripped). `corpus_chunks.tsv` (the Postgres
  `GENERATED ALWAYS AS (tsvector...) STORED` column + its GIN index) is
  rewritten to a plain, ungenerated `TEXT` column rather than dropped —
  full-text search over a backup file still isn't a goal, but downstream
  `SELECT *` no longer needs a special case for the missing column.
- **Never overwrites**: each run either targets a fresh timestamped path
  (`backups/nuwrrrld-<timestamp>.sqlite`) or refuses if `--out` already
  exists. `backups/` is gitignored (added by PR #120 —
  [[incident-2026-09-11-sqlite-backup-dead-since-launch]] found it wasn't,
  and a local run had already left one in the working tree) — the files can
  carry Clerk user IDs, IP hashes, and consent records.
- Load order is table-alphabetical, not dependency order (e.g. `ticker_cards`
  sorts before its own `ticker_universe` parent), so the import runs with
  `PRAGMA foreign_keys = OFF` and re-verifies with `PRAGMA foreign_key_check`
  once everything is loaded — a real FK violation in the source data still
  fails loudly; only load-order noise is suppressed.

## Where used

- **Manual, local:** `node --env-file=.env.local scripts/backup-to-sqlite.mjs`.
  Nothing in the app reads the resulting file — this is backup, not a live
  data path.
- **Scheduled, CI:** `.github/workflows/backup-to-sqlite.yml` — daily at
  03:00 UTC (after `hydrate-universe`'s 22:30 UTC and `precompute-ai`'s
  00:10 UTC runs, so the snapshot captures both), plus manual
  `workflow_dispatch` with `tables`/`exclude` inputs mapping straight to the
  script's own flags. Requires Node 22+ in `setup-node` (`node:sqlite`'s
  hard floor) — every other workflow in this repo can use `'20'` or `'22'`
  interchangeably; this one can't drop to 20. Uploads the result as a
  14-day workflow artifact (`nuwrrrld-sqlite-backup-<run-id>`) — a rolling
  convenience copy, not durable archival; there's no push-to-storage step.
- See `docs/local-sqlite-backup-and-offline-dev.md` for the full usage guide
  (including how to reproduce each scheduled GitHub Actions *pipeline's* own
  writes by pointing its underlying script/curl call at `localhost`) and
  `docs/sqlite-backup-code.md` for a code-only reference covering both paths.

## Known failures

1. **`schema.sql`'s declarations can silently diverge from the live
   database, and only this script notices.** See
   [[incident-2026-09-11-sqlite-backup-dead-since-launch]] — a
   `CREATE TABLE IF NOT EXISTS` against a table that already existed in
   production is a no-op, so the checked-in schema quietly stopped matching
   reality (`signal_digest_cache.created_at`, undeclared since the table's
   introduction). `npm run db:check-sqlite-schema` didn't catch it because it
   only compares the two schema *files* to each other; this script is the
   only thing in the repo that introspects the live database, and it failed
   loudly — 7 consecutive backup failures — rather than ship a snapshot
   silently missing a column.
2. **The live database has tables this repo doesn't know about.** See
   [[incident-2026-09-03-unowned-tables-in-shared-neon-db]] — `comments`,
   `invoices`, `processed_webhook_events`, `rate_limit_counters` exist in
   the real Neon database but aren't declared in `lib/db/schema.sql` and
   aren't referenced anywhere in this repo's code. The exporter's default
   behavior (skip anything not present in `schema.sqlite.sql`, with a loud
   warning) is what caught this rather than silently including it.
3. **`numeric` loses precision.** Postgres's arbitrary-precision `numeric`
   columns (`live_prices.price`, `followed_ticker_picks.entry_price`, Stripe
   money fields) become SQLite `REAL` (IEEE 754 double). Fine for inspecting
   a backup; wrong for re-deriving financial math from the exported file.
4. **This is a one-way, read-only export.** There is no restore-into-Neon
   path and no live SQLite-backed app mode — see "Open questions" below and
   `docs/local-sqlite-backup-and-offline-dev.md` §4 for why a live mode is a
   materially bigger change (26 files import `lib/db.ts`'s Neon-only HTTP
   client; a swappable driver would need every one of those files' raw SQL
   audited for Postgres-only syntax — `ON CONFLICT`, `RETURNING`, jsonb
   operators, `tsvector`/GIN full-text search — none of which is visible from
   the schema alone). PR #105 did exactly that audit for 10 of the 14
   `lib/*-db.ts` modules — see [[entity-db-parity-suite]] — and found the
   modules themselves compatible; the harder remainder (`unnest()`,
   `= ANY(array)`, `string_agg(DISTINCT …)`) is the concrete list of what a
   live SQLite-backed mode would still need to solve.

## Open questions

- ❓ Should a restore-from-backup path exist (SQLite file → fresh Neon
  branch), or is read-only inspection the only intended use? No current
  consumer needs restore.
- ❓ `node:sqlite` is still flagged experimental by Node itself
  (`ExperimentalWarning: SQLite is an experimental feature and might change
  at any time`). Worth revisiting if a future Node LTS stabilizes it, or if
  the warning becomes disruptive in scripted/CI use.
- ❓ Per [[incident-2026-09-03-unowned-tables-in-shared-neon-db]]: should the
  four undeclared tables ever be onboarded into `schema.sql`/`schema.sqlite.sql`,
  or does this Neon project need to be split so an unrelated app's data isn't
  reachable from this repo's connection string at all?
- ❓ Per [[incident-2026-09-11-sqlite-backup-dead-since-launch]]: three more
  `signal_digest_cache` columns (`id`, `period_label`, `generated_at`) are
  drifted between `schema.sql` and production the same way `created_at` was,
  just not in a way that breaks the backup. Worth a dedicated pass over
  `information_schema` vs. every `schema.sql` table, not just this one.

## See also

- [[incident-2026-09-11-sqlite-backup-dead-since-launch]] — the workflow's
  own preflight guard catching a `schema.sql` declaration that had silently
  stopped matching production
- [[incident-2026-09-03-unowned-tables-in-shared-neon-db]] — the PII/shared-DB finding this tool surfaced
- [[entity-db-parity-suite]] — the generator + contract-test pair PR #105 added on top of this entity
- `../local-sqlite-backup-and-offline-dev.md` — full usage guide, workflow→table mapping, and the scoped-but-not-built live-SQLite-dev-server plan
- [[entity-ticker-universe-pipeline]] — the largest single data source this backup captures (`ticker_universe`/`ticker_cards`, 983/1864 rows as of the PR #98 test run)
- [[entity-ai-council]] — `council_sessions`/`council_messages`/`council_verdicts`, also captured
