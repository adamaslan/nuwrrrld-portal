---
date: 2026-09-03
type: entity
tags: [database, backup, sqlite, neon, offline]
sources: [../../scripts/backup-to-sqlite.mjs, ../../lib/db/schema.sqlite.sql, ../local-sqlite-backup-and-offline-dev.md, PR#98]
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
  strings, `boolean` → 0/1, `numeric` → `REAL`) before inserting.
- **`lib/db/schema.sqlite.sql`** — the SQLite translation of `lib/db/schema.sql`'s
  30 tables, verified for exact table-name parity. `corpus_chunks.tsv` (the
  Postgres `GENERATED ALWAYS AS (tsvector...) STORED` column + its GIN index)
  is dropped entirely — no SQLite equivalent attempted, since full-text search
  over a backup file isn't a goal.
- **Never overwrites**: each run either targets a fresh timestamped path
  (`backups/nuwrrrld-<timestamp>.sqlite`) or refuses if `--out` already
  exists. `backups/` is gitignored — the files can carry Clerk user IDs, IP
  hashes, and consent records.
- Load order is table-alphabetical, not dependency order (e.g. `ticker_cards`
  sorts before its own `ticker_universe` parent), so the import runs with
  `PRAGMA foreign_keys = OFF` and re-verifies with `PRAGMA foreign_key_check`
  once everything is loaded — a real FK violation in the source data still
  fails loudly; only load-order noise is suppressed.

## Where used

- Manual/on-demand only: `node --env-file=.env.local scripts/backup-to-sqlite.mjs`.
  Nothing in the app reads the resulting file — this is backup, not a live
  data path. See `docs/local-sqlite-backup-and-offline-dev.md` for the full
  usage guide, including how to reproduce what each scheduled GitHub Actions
  workflow writes by pointing its underlying script/curl call at `localhost`
  instead of production.

## Known failures

1. **The live database has tables this repo doesn't know about.** See
   [[incident-2026-09-03-unowned-tables-in-shared-neon-db]] — `comments`,
   `invoices`, `processed_webhook_events`, `rate_limit_counters` exist in
   the real Neon database but aren't declared in `lib/db/schema.sql` and
   aren't referenced anywhere in this repo's code. The exporter's default
   behavior (skip anything not present in `schema.sqlite.sql`, with a loud
   warning) is what caught this rather than silently including it.
2. **`numeric` loses precision.** Postgres's arbitrary-precision `numeric`
   columns (`live_prices.price`, `followed_ticker_picks.entry_price`, Stripe
   money fields) become SQLite `REAL` (IEEE 754 double). Fine for inspecting
   a backup; wrong for re-deriving financial math from the exported file.
3. **This is a one-way, read-only export.** There is no restore-into-Neon
   path and no live SQLite-backed app mode — see "Open questions" below and
   `docs/local-sqlite-backup-and-offline-dev.md` §4 for why a live mode is a
   materially bigger change (26 files import `lib/db.ts`'s Neon-only HTTP
   client; a swappable driver would need every one of those files' raw SQL
   audited for Postgres-only syntax — `ON CONFLICT`, `RETURNING`, jsonb
   operators, `tsvector`/GIN full-text search — none of which is visible from
   the schema alone).

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

## See also

- [[incident-2026-09-03-unowned-tables-in-shared-neon-db]] — the PII/shared-DB finding this tool surfaced
- `../local-sqlite-backup-and-offline-dev.md` — full usage guide, workflow→table mapping, and the scoped-but-not-built live-SQLite-dev-server plan
- [[entity-ticker-universe-pipeline]] — the largest single data source this backup captures (`ticker_universe`/`ticker_cards`, 983/1864 rows as of the PR #98 test run)
- [[entity-ai-council]] — `council_sessions`/`council_messages`/`council_verdicts`, also captured
