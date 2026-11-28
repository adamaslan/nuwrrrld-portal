---
date: 2026-11-27
type: decision
tags: [backup, sqlite, neon, transfer, quota, daily_bars]
sources: [../../scripts/backup-to-sqlite.mjs, ../../scripts/backup-incremental.mjs, ../../scripts/backup-restore.mjs, ../../__tests__/backup-incremental.test.ts, ../../.github/workflows/backup-to-sqlite.yml]
---

# Decision: Incremental SQLite Backups Read daily_bars as a Delta, Off by Default

## Decision

[[entity-sqlite-backup]] gains an opt-in incremental mode. `--incremental-base=<previous backup>` reads only the `daily_bars` rows whose `fetched_at` moved since that backup's snapshot. The delta reaches back to the earlier of 6 hours before the snapshot or the oldest open transaction the snapshot could see. Every other table is still read in full on every run. A new restore script rebuilds one complete snapshot from a full backup plus the incrementals taken after it. The scheduled workflow does not pass the flag, so nothing changes until the owner turns it on.

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

- Every backup file now carries `_backup_meta` (kind, captured_at, schema, table-layout and manifest hashes, base link, late-commit bound) and `_backup_manifest`. The manifest is the file's exact inventory: every data table appears, including zero-row tables, tables the source database lacks (`absent`) and tables a filter skipped (`excluded`). Both tables are written in one transaction. Each run builds its file in a staging directory it alone owns (created next to the destination), then publishes it with a link that fails rather than overwrite an existing backup. Two runs aimed at the same path can't publish each other's file.
- The delta rows, the table's live count and the clock that anchors the next run come from one read-only REPEATABLE READ transaction. A write that commits mid-run therefore cannot make a link disagree with itself. The trade-off is that a delta must fit in one Neon response (64 MB); a larger delta fails and asks for a full backup.
- Every file is re-checked before it is used as a base or restored: kind, filter state, actual table layout, manifest modes, actual row counts and mandatory delta counts. Restore also refuses a missing or out-of-order link, a schema change mid-chain, or links covering different tables. When the restored `daily_bars` count doesn't match the live count, the error says whether rows are missing or are stale rows deleted at the source. The fix in each case is a new full backup.
- Postgres `now()` is the time a transaction starts, so a writer that began before a snapshot and committed after it stamps rows older than the snapshot. Today the only writer is a single autocommit statement, so that window lasts as long as one statement runs. Activity is sampled both just before the snapshot and inside it, because a writer can commit after the data snapshot and before the in-snapshot sample, and then appear in neither. The next delta reaches back to the oldest open transaction in either sample, or to the earlier sample's time if that is older. When any sample can't see every session, the file is labelled `late_commit_bound = overlap-only`, and a restored copy built on such a base says `late_commit_guarantee = overlap-only`. In that case a writer transaction left open longer than 6 hours that the role can't see may be missed until the next full backup. A `SET LOCAL statement_timeout` on that writer would turn this into a hard bound; it was offered as an optional follow-up.
- Turning it on still needs periodic full checkpoints. Artifacts are kept for 14 days, so the full backup at the start of a chain has to stay within that window.
- The watermark relies on every write to `daily_bars` stamping `fetched_at` and on nothing deleting from the table. A tripwire test reads `lib/engine-db.ts` and scans `app/`, `lib/`, `scripts/` and `deploy/` so a change to either assumption fails CI. A planned change that only rewrites bars whose content changed still preserves the invariant.

## Validated by

- Synthetic-fixture tests in `__tests__/backup-incremental.test.ts`, with a WAL-mode SQLite file standing in for Postgres and a second connection providing snapshot isolation. On the same data, a full export took 3 statements / 3 requests, 6,024 rows and 1,126,467 JSON bytes; the incremental took 5 statements / 3 requests, 29 rows and 5,126 JSON bytes. Restoring full + 2 incrementals matches a fresh full export row for row. Further tests cover:
  - an insert landing between the delta read and the count;
  - late commits inside the window, and one just outside it (caught when the writer was visible; otherwise labelled, and repaired by the next full backup);
  - tampered or partial files, including an abrupt kill while metadata is being written;
  - the no-overwrite publish.
- Further regression tests from the second review cover two runs publishing to the same path, a writer that commits between the data snapshot and the activity sample, and an emptied table removed from the manifest.
- Independent review: Codex (gpt-6.2-sol) asked for changes in two rounds; this page records the design after both sets of fixes.
- Not validated: any run against production. The database is quota-restricted, and running an export there was not authorized.

## See also

- [[entity-sqlite-backup]]
- [[incident-2026-09-11-sqlite-backup-dead-since-launch]]
- [[decision-precompute-ai-at-quota-reset]]
