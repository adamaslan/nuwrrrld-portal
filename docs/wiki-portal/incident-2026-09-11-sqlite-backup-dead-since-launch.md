---
date: 2026-09-11
type: incident
tags: [database, backup, sqlite, neon, github-actions, schema-drift, monitoring]
sources: [../../.github/workflows/backup-to-sqlite.yml, ../../scripts/backup-to-sqlite.mjs, ../../lib/db/schema.sql, ../../lib/db/schema.sqlite.sql, PR#120]
---

# Incident — Nightly SQLite Backup Failed Every Run Since Launch

## Date & severity

**Discovered 2026-09-11**, fixed same day (PR #120). **Moderate.** No code
path depends on the backup, but it existed specifically as disaster-recovery
insurance — see [[entity-sqlite-backup]] — and that insurance did not exist
in practice for its entire lifetime.

## What happened

`.github/workflows/backup-to-sqlite.yml` runs daily at 03:00 UTC. From its
introduction on 2026-09-04 through 2026-09-10 it ran **7 times and failed 7
times**, always in ~20 seconds, always on the same guard, before making a
single query against Neon:

```
✖ Backup failed: Live column(s) not present in lib/db/schema.sqlite.sql
  (add them there, or list them in EXPECTED_UNMIRRORED_COLUMNS if
  intentionally dropped): signal_digest_cache.created_at
```

There was no off-site snapshot of the production database at any point in
that window — not stale, not partial. None.

The workflow's own `notify`-equivalent step (`Upload pipeline artifacts` /
step summary) ran, but nothing surfaced the pattern of 7 consecutive reds to
a human. Same shape as
[[incident-2026-09-03-nightly-hydration-dead-15-days]]: a scheduled job dying
silently on a preflight guard.

## Root cause

`signal_digest_cache` predates its own declaration in `lib/db/schema.sql`.
`docs/nuwrrrld-portal-import/portal-10x-council-db-local.md` records this
directly: `-- signal_digest_cache already exists; keep as the global-cache
table.` Because the declaration is a `CREATE TABLE IF NOT EXISTS`, Postgres
skipped the block entirely — the table already existed, so the statement
never ran and never reconciled the declared shape with the live one.

The declared schema has been fiction since commit `116d6d7`. Production holds
a `created_at timestamptz NOT NULL DEFAULT now()` column that neither
`schema.sql` nor `schema.sqlite.sql` knew about.

`npm run db:check-sqlite-schema` — the CI check that would normally catch
schema drift — stayed green throughout, because it only compares the two
schema *files* to each other; both were wrong in the same way. The backup
script was the only thing in the repo that introspects the *live* database
(`information_schema.columns`) rather than trusting a checked-in file, and it
was therefore the only thing positioned to notice. The moment it did, it
correctly refused to ship a snapshot silently missing a column — see
[[entity-sqlite-backup]] "Known failures" — rather than fail the CI schema
check, it failed the backup itself.

## Resolution

Declared `created_at` in `lib/db/schema.sql` and regenerated
`lib/db/schema.sqlite.sql` via `npm run db:gen-sqlite-schema`. Deliberately
**not** added to `EXPECTED_UNMIRRORED_COLUMNS` — the column holds real data
(rows dated 2026-07-15 and 2026-07-24), so suppressing it would have made
every future backup silently lossy instead of loudly broken, which is worse:
green runs with an incomplete snapshot are harder to catch than red runs with
none.

Verified against production directly before opening the PR: 31 tables, 2,912
rows, `created_at` present and populated on both existing rows,
`PRAGMA integrity_check` clean, no FK violations. Then verified in CI itself
— `backup-to-sqlite.yml` was manually dispatched against the fix branch
(not `main`, since dispatching from the unfixed default branch would have
failed identically) and completed successfully: run
[34561796723](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/34561796723),
every step green, artifact uploaded. First successful run in this workflow's
history.

Also closed in the same PR: `/backups/` was not in `.gitignore`, even though
the script's default `--out` writes there. A local run had already dropped a
full production copy — `consent_records`, `user_attribution`,
`disclaimer_acks` included — into the working tree as an untracked file, one
`git add -A` away from landing in a public repo. Nothing had hit this only
because the workflow had never once succeeded and nobody had run the script
locally before this incident's investigation.

## Impact on design

None to the backup tool's design — the guard that caused the outage is the
same guard [[entity-sqlite-backup]] already documents as intentional, and it
did exactly what it was built to do. The gap this incident exposes is
upstream: nothing reconciles `schema.sql` against the *live* database except
this one backup script, so a `CREATE TABLE IF NOT EXISTS` against a
pre-existing table is a silent no-op with no other detector in the repo.

## Open items

- ❓ **Three more columns are drifted the same way, left open.** `id`
  (declared `bigint GENERATED ALWAYS AS IDENTITY`, live `integer`/serial),
  `period_label` (declared nullable, live `NOT NULL`), `generated_at`
  (declared `DEFAULT now()`, live no default). None break the backup — the
  guard only checks for columns *absent* from the mirror, not type/nullability
  mismatches — but a database built fresh from `schema.sql` today would not
  match production. Deferred to its own change; fixing it touches
  fresh-environment provisioning semantics, not just backup correctness.
- ❓ **The fix must land on `main` before the next scheduled run (~03:00 UTC
  daily) to actually close this incident.** The verified CI success was a
  manual dispatch from the PR branch; the scheduled cron still runs against
  whatever is on `main`.
- ❓ **Does the workflow's failure path actually notify anyone?** Per
  [[incident-2026-09-03-nightly-hydration-dead-15-days]], this is the second
  time a scheduled job in this repo has failed silently for an extended
  period. Worth verifying end-to-end whether either workflow's failure
  handling reaches a human, rather than assuming it does because the YAML
  has a notify-shaped step.

## See also

- [[entity-sqlite-backup]] — the tool this incident is about
- [[incident-2026-09-03-nightly-hydration-dead-15-days]] — the prior incident
  with the identical shape (scheduled job, silent preflight failure, no
  alerting)
- [[incident-2026-09-03-unowned-tables-in-shared-neon-db]] — the other
  schema-drift finding this same backup script surfaced, one week earlier
- [[entity-db-parity-suite]] — the file-vs-file schema check that stayed
  green throughout this incident because it never looks at the live database
