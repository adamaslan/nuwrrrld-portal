# R02 — Safe development data and backup audit

**Checked:** 2026-10-21 18:30–18:35 UTC
**Source TODO:** `docs/nwf-consolidated-todo-2026-10-20.md` was not present on `origin/main`; scope comes from the assigned R02 task.
**Scope:** read-only repository, Neon project/branch/snapshot metadata, and backup policy review. No credentials, `.env*` files, database rows, or production settings were read or changed.

## Findings

| Check | Status | Evidence |
|---|---|---|
| Nonproduction branches exist | **VERIFIED, unsafe for assumed-local use** | Neon project `neon1` has ready branches `nwf-core` and `nwf-hydration`. Both descend from primary `main` at parent timestamp `2026-10-17 18:30:55 UTC`; both have approximately 166 MB logical size. This indicates they may contain production-derived data. No sanitization evidence was found. |
| Production branch protection | **VERIFIED** | `main` is the primary/default branch; Neon metadata marks deletion and read-write endpoint movement as restricted because it is Vercel's production branch. No production setting was changed. |
| Snapshot inventory | **VERIFIED** | One manual snapshot exists: `archived-slot1-20261017`, sourced from `main`, created `2026-10-17 20:04:23 UTC`. |
| Scheduled snapshots | **VERIFIED: none listed** | Neon returned an empty snapshot schedule for `main`, `nwf-core`, and `nwf-hydration` at audit time. Project metadata reports `history_retention_seconds: 21600` (six hours); this is recorded as metadata, not treated as a restore test or an adequate archive policy. |
| Restore rehearsal | **NOT VERIFIED** | No completed restore rehearsal is evidenced. Separate branches exist, but their isolation/sanitization as a restore target is not verified. No restore was attempted. |
| Pipeline database guard | **VERIFIED in source; runtime configuration NOT CHECKED** | `lib/pipeline-db-guard.ts` is opt-in: with `PRODUCTION_DB_HOST` unset it warns once and permits a live run; when configured, it rejects only an exact host match. `resolveDbHost()` returns `null` for a missing or unparsable `DATABASE_URL`, and that value is not rejected by the guard. The current environment value was not read, so the guard's active runtime state is unknown. This fail-open edge needs judgment-tier review; this audit did not change the protected guard. |
| Daily SQLite export | **VERIFIED in source; recent run status NOT CHECKED** | `.github/workflows/backup-to-sqlite.yml` schedules a read-only Neon export daily at 03:00 UTC and stores a GitHub artifact for 14 days. The workflow explicitly describes this as a convenience copy, not Neon PITR. The GitHub run-history query failed, so no recent success is claimed. |
| Restore tooling | **NOT VERIFIED / manual path only** | `docs/sqlite-backup-code.md` documents manual restoration into a fresh Neon dev branch and says there is no automated restore path. A successful run is not evidenced. |
| Archive/DSAR retention decision | **OPEN; owner not identified** | The repo documents a 14-day artifact window, but no durable archive-retention choice or named decision owner was found. |

## Human gate and safe acceptance steps

Before creating another branch or restoring any snapshot, the owner must approve the exact source branch/snapshot and confirm the target is isolated and access-controlled. Branches sourced from production can copy financial or user data. Do not use the existing production-derived branches as safe local targets until their data handling and sanitization are confirmed.

After approval:

1. Record an explicitly nonproduction branch and its parent/source; verify credentials and local configuration point only to that target without printing connection strings.
2. Keep the guard in the judgment tier. Confirm its configured production host and decide the fail-closed behavior for missing/unparsable database URLs before enabling live local/dashboard writes; verify with controlled tests that do not write to production.
3. Perform a documented restore into an isolated nonproduction target; verify schema and representative row counts without exposing PII, then record recovery time and any gaps.
4. Have the data/privacy owner choose retention for Neon history, manual snapshots, SQLite artifacts, and DSAR/archive data separately; document deletion and access controls.
5. Verify a recent scheduled SQLite artifact after GitHub access is available, and retain it only according to the approved policy.

**Disposition:** R02 remains open. The existing branches and manual snapshot are inventory evidence; they do not prove a sanitized development dataset, scheduled snapshot coverage, or a successful restore rehearsal. No branch, snapshot, schema, database row, or production configuration was changed.
