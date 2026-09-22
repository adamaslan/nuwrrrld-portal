---
date: 2026-09-22
type: incident
tags: [paper-portfolios, github-actions, scheduling, openrouter, arbitration]
sources: [../../.github/workflows/paper-portfolios.yml, ../modal-pipeline-status.md, PR#147, docs/manual-setup-todo.md, docs/caveats/2026-09-14-council-paper-portfolios-db-safety.md]
---

# Incident — Paper-Portfolios Arbitration Never Ran, Every Scheduled Trigger Skipped

## Date & severity

**Discovered 2026-09-22** (via `docs/modal-pipeline-status.md`'s free-tier
audit), fixed same day for its scheduling half (PR #147). **Moderate** — no
data loss, but a feature shipped across 5 build phases
([[entity-paper-portfolios]]) has produced zero runs, zero orders, and zero
OpenRouter arbitration calls since going live.

## What happened

`.github/workflows/paper-portfolios.yml`'s `gate`/`check` step resolved which
of the four daily slots (preopen/midday/preclose/settle) had fired by
matching the NY wall-clock time against `09:00`/`12:30`/`15:45`/`16:30` with
**exact string equality** (`case "$NY_TIME" in 09:00) ... esac`). GitHub
Actions scheduled runs commonly start 30–90 minutes late under load, so the
exact-minute match essentially never fired. **All 38 scheduled runs recorded
2026-09-15 through 2026-09-22 resolved `run=skipped`.** Example log line:
`NY local time 13:47 matches no slot — off-season cron entry, skipping.`

Because the gate job runs first and is green whether or not a slot matched,
**the workflow was green on every run** — nothing alerted. Same failure shape
as [[incident-2026-09-11-sqlite-backup-dead-since-launch]] and
[[incident-2026-09-03-nightly-hydration-dead-15-days]]: a scheduled job dying
silently on its own preflight/gate step.

## Root cause

Exact-minute matching against a cron trigger with no start-time guarantee.
GHA's own scheduling docs describe delayed starts as expected behavior under
load, not an edge case — the gate needed a window match from the start.

## Resolution

Replaced the exact `case` match with a window (slot start ≤ NY time < next
slot's start; `settle` extends to end-of-day). Verified safe against a
duplicate qualifying tick because the run route already has idempotency two
layers deep: `paper_runs` has a unique constraint on
`(account, trade_date, slot)`, and `lib/paper-engine.ts::runAccountSlot` does
an early `getRun()` check plus an `ON CONFLICT DO NOTHING` race-recovery path
on the insert itself. A duplicate trigger inside the new window hits the
existing early-return, not a second run.

## Open items

Two more blockers, already filed in `docs/manual-setup-todo.md` (added
2026-09-13/14) and independently confirmed by a prior session
([[entity-paper-portfolios]] cross-references
`docs/caveats/2026-09-14-council-paper-portfolios-db-safety.md`), predate
this incident and remain open:

1. **`PAPER_CRON_SECRET` was never generated or pushed to GitHub Actions
   secrets.** The workflow's "Verify required secrets exist" step fails
   before ever calling the route until this is done via the `secrets-sync`
   skill.
2. **`paper_accounts` has 0 rows.** `scripts/seed-paper-portfolios.mjs` has
   only ever been dry-run. A 2026-09-14 session stopped before running it for
   real because it could not confirm the local `DATABASE_URL` points at a
   non-prod Neon branch — `lib/pipeline-db-guard.ts`'s `PRODUCTION_DB_HOST`
   prod-write guard is unset and therefore inert, so nothing in the repo's
   own tooling would stop a real write against production if the local
   `DATABASE_URL` happened to point there.

Both are production secret/DB-write actions requiring explicit user
confirmation of the target environment — deliberately not folded into PR #147
or any automated fix. The gate fix in isolation makes scheduled runs resolve
a slot correctly; it does not make them complete successfully until both
items above are resolved.

## Impact on design

Per `docs/modal-pipeline-status.md`, this is also why OpenRouter's daily
arbitration budget (≤108 calls/day, per [[entity-paper-portfolios]]'s Phase 5
arbitration design) has never been spent — `paper_runs` and `paper_orders`
are both empty in Neon. The AI budget doubling planned in that doc's Phase 10
depends on this incident being fully closed (gate fix + secret + real seed),
not just the scheduling half.
