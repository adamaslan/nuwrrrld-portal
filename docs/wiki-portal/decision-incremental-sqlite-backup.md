---
date: 2026-11-27
type: decision
tags: [backup, sqlite, neon, transfer, quota, daily_bars]
sources: [../../scripts/backup-to-sqlite.mjs, ../../scripts/backup-incremental.mjs, ../../scripts/backup-restore.mjs, ../../__tests__/backup-incremental.test.ts, ../../.github/workflows/backup-to-sqlite.yml]
---

# Decision: Incremental SQLite Backups Read daily_bars as a Delta, Off by Default

## Decision

[[entity-sqlite-backup]] gains an opt-in incremental mode. `--incremental-base=<previous backup>` reads only the `daily_bars` rows whose `fetched_at` moved since that backup was captured, with a 6-hour overlap. Every other table is still read in full on every run. A new restore script rebuilds one complete snapshot from a full backup plus the incrementals taken after it. The scheduled workflow does not pass the flag, so nothing changes until the owner turns it on.

## Date

2026-11-27

## Context

Every nightly backup re-read the whole database over Neon's HTTP driver. In November 2026 there were 25 successful full exports (Nov 1–25), each one reading 790k–990k rows. `daily_bars` made up 751k–768k of those rows each night, yet only about 1,000 of them changed per weekday. Neon then refused queries with HTTP 402 once the project went over quota: the Nov 26 and Nov 27 backups failed on their first query and produced no artifact. Gzipping the artifact (45 MB on Nov 25) does not reduce what leaves Neon. Rough estimate: re-reading `daily_bars` in Nov 1–25 came to about 2.3–3.9 GB of uncompressed JSON. That figure comes from row counts multiplied by a measured per-row JSON size. It is not billed transfer, and nobody has measured how much of the backup's transfer Neon actually bills.

## Alternatives considered

- **Turn backups off or run them less often.** That cuts transfer by giving up restore coverage, and changing the schedule is the owner's call.
- **Read every table incrementally.** Not safe today. On `news_articles`, the `corroborated` flag is updated without touching `updated_at`. `news_article_symbols` has no timestamp column. `news_article_scores` rows can vanish through `ON DELETE CASCADE`. A delta would quietly miss changes in all three, so they stay full.
- **Pick the delta window from the clock (e.g. "the last 26 hours").** Rejected: a failed night would open a gap that nobody notices. The delta is anchored on the previous backup's own database-clock `captured_at`.
- **Add an index on `daily_bars.fetched_at`.** That is a schema migration, which this change has no authority to make. Without the index the delta query scans the primary-key index on the server. That costs compute, not transfer.

## Consequences

- Every backup file now carries `_backup_meta` (kind, captured_at, schema hash, base link) and `_backup_manifest` (per-table mode, rows, live count).
- Restore refuses to build a copy that would be quietly incomplete. It stops when a link is missing or out of order, when the SQLite schema changed mid-chain, when a file is a filtered `--tables`/`--exclude` backup, or when `daily_bars`' restored row count doesn't match the live count (a delete the delta could not see). The fix in each case is a new full backup.
- Turning it on still needs periodic full checkpoints. Artifacts are kept for 14 days, so the full backup at the start of a chain has to stay within that window.
- The watermark relies on every write to `daily_bars` stamping `fetched_at` and on nothing deleting from the table. A tripwire test reads `lib/engine-db.ts` and scans `app/`, `lib/`, `scripts/` and `deploy/` so a change to either assumption fails CI. A planned change that only rewrites bars whose content changed still preserves the invariant.

## Validated by

- Synthetic-fixture tests in `__tests__/backup-incremental.test.ts` (SQLite standing in for Postgres). On the same data, a full export took 3 queries, 6,024 rows and 1,126,427 JSON bytes; the incremental took 4 queries, 28 rows and 5,000 JSON bytes. Restoring full + 2 incrementals matches a fresh full export row for row. Further tests cover late commits picked up by the overlap, delete detection, gap and schema-change refusal, and an interrupted read leaving no partial rows.
- Not validated: any run against production. The database is quota-restricted, and running an export there was not authorized.

## See also

- [[entity-sqlite-backup]]
- [[incident-2026-09-11-sqlite-backup-dead-since-launch]]
- [[decision-precompute-ai-at-quota-reset]]
