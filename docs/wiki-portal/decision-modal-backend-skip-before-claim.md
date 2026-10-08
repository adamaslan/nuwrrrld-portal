---
date: 2026-10-07
type: decision
tags: [modal, idempotency, council, cron, run-key]
sources: [../../deploy/modal-backend/nuwrrrld/jobs/entrypoints.py, ../../deploy/modal-backend/nuwrrrld/jobs/runner.py]
---

# Decision — Multi-Fire Jobs Decide "Act Today?" Before Claiming Their Run Key

## Decision

A scheduled job whose cron fires more than once per run-key period (the weekly council: Thursday and Friday, one ISO-week key) checks whether today is the acting day *before* claiming `(job, run_key)`. If not, it returns skipped and writes no `job_runs` row.

## Date

2026-10-07

## Context

The claim guard treats `succeeded` and `skipped` as terminal: a later run of the same key returns `not_claimed`. The weekly council is scheduled Thursday and Friday so that a Friday market holiday still gets a run on Thursday, and it acts only on the week's last session. The original code claimed first and skipped inside the claim, so Thursday's skip made Friday a no-op and the weekly council could never act in a normal week.

## Alternatives considered

- **Per-day run key for weekly jobs.** Simple, but loses the guarantee of exactly one weekly action per week; Thursday and Friday could both act on a holiday-shortened week boundary.
- **Let a skipped claim be retaken.** Changes the guard's meaning for every job, and a skipped claim is correct for single-fire jobs on a closed market.
- **Check before claiming (chosen).** Local to the one job class that needs it, and keeps one row per ISO week.

## Consequences

- Thursday leaves no trace in `job_runs`; the watchdog must not alert on a missing Thursday row.
- An explicit `run_key` or `force` bypasses the pre-check, so an operator can still run it by hand.
- Any future multi-fire job needs the same pre-check; a test should assert that a skip does not consume the key.

## Validated by

An entrypoint test that runs Thursday (skips, no row) then Friday (acts, one row for the week). It passed on a real local Postgres. Not validated on Modal.

## See also

- [[entity-modal-backend]]
