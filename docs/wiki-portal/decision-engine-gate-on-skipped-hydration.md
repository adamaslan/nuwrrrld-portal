---
date: 2026-11-28
type: decision
tags: [engine, neon, scheduled-jobs, hydration, daily-bars, gate]
sources: [../../scripts/engine-gate.mjs, ../../lib/engine-db.ts, ../../.github/workflows/engine-nightly.yml, ../../.github/workflows/hydrate-universe.yml, ../../__tests__/engine-gate.test.ts, ../../__tests__/engine-db.pg.test.ts, PR#459]
---

# Decision — Don't Start the Engine After a Hydration Run That Explicitly Did Nothing

## Decision

Engine nightly may skip its run only on an explicit signal from the hydration
run that triggered it, never by inferring "nothing changed" from timestamps or
earlier engine runs:

- `scripts/engine-gate.mjs` skips only when **all** of these hold:
  - the triggering hydration run's single `[done]` line reads
    `status=skipped … written=0 … total=0`, the same shape
    `hydrate-universe.yml`'s Summarize step already accepts as a clock-gate
    skip;
  - that run was attempt 1 and has exactly one `hydrate-log` artifact;
  - the previous engine-nightly run completed with `success`.
- Any other input runs the engine as before, including a manual dispatch, a
  missing or unreadable log, a malformed or duplicated `[done]` line, a hydration
  that wrote or attempted anything, a re-run attempt, and a previous engine run
  that failed, was cancelled or skipped, or is still running.
- A skip is written as its own step outcome and a
  `### Engine nightly: not run (…)` summary line in that workflow run. That
  keeps it distinct from a computed run where NuLogDash's engine card already
  points (the platform execution history).
- Activation needs an `engine-nightly.yml` change: a step that reads the artifact
  count and the previous run with the job token (`actions: read`), downloads the
  artifact for `workflow_run.id`, and runs the parser before `npm ci`. It is
  **staged in the PR body as an owner decision, not committed.**

Shipped alongside it: `upsertBars` rewrites a stored bar only when a non-key
column changed, so `fetched_at` moves only on real changes. It still stamps the
database `now()`, which the incremental backup in PR #458 depends on. Each upsert
runs in one transaction with `SET LOCAL statement_timeout = '5min'`, which ends
at COMMIT.

## Date

2026-11-28

## Context

`engine-nightly.yml` runs after every successful hydration run, and hydration
has two crons. GitHub fires the midday cron hours late, often after the close,
and the intraday lane then exits `status=skipped written=0 total=0` with a green
workflow, so the engine ran anyway. Replaying the gate over the real runs from
2026-11-24 to 2026-11-27:

| Engine run | Triggering hydration | Hydration `[done]` | Previous engine run | Gate |
|---|---|---|---|---|
| 45512023470 (11-24 23:41 UTC) | 45511878149 | skipped, written 0, total 0 | success | skip |
| 45550616651 (11-25 05:00) | 45550349300 | partial, written 1992 | success | run |
| 45721099041 (11-25 23:24) | 45720934097 | skipped, written 0, total 0 | success | skip |
| 45754285234 (11-26 04:17) | 45754064841 | partial, written 1992 | success | run |
| 45910721762 (11-26 23:24) | 45910603003 | skipped, written 0, total 0 | success | skip |
| 46080192964 (11-27 23:02) | 46080091988 | skipped, written 0, total 0 | skipped (hydration had failed) | run |

The three skipped triggers each led to an engine run that read up to 300 bars
for every active ticker. In a local fixture (1,033 tickers × 320 bars) that
recompute costs 21 queries, 310,936 rows and about 47.9 MB of serialized JSON
results. That figure is a fixture-only estimate, not Neon billed transfer. A
gated trigger makes no portal or database calls at all.

## Alternatives considered

- **A covering-run watermark** (skip when a complete run started after the
  newest bar change). Built first, then dropped after review: duplicate or
  missing pages, universe races, writers on another feed or still running,
  bar commits that became visible late, and the effective date could each
  produce a false skip. Fixing all of them is a run-ledger and fencing rewrite.
  See `archive/decision-engine-skip-unchanged-bars-2026-11-27.md`.
- **Read the outcome without a workflow change.** The engine's steps get no
  token, so they could only read the unauthenticated check-run annotation text,
  which is coupled to message wording and rate-limited from shared runner IPs.
- **Trigger the engine only from the nightly cron.** Wrong whenever the midday
  cron fires after the close and is the first to see the new bar.

## Consequences

- On a skipped-hydration trigger, the day's bar is computed by the next
  hydration-triggered run, a few hours later in the observed runs. Engine output
  is shadow-only, so no user-facing freshness changes.
- If the evening engine run fails, the next trigger always recomputes.
- Until the owner applies the staged YAML, the parser is inert and behavior is
  unchanged.
- The change-only upsert stops restamping unchanged trailing-week refetches
  (6,198 rows per run in the fixture), which also keeps #458's delta small.

## Validated by

`__tests__/engine-gate.test.ts` covers the real `[done]` lines and every
fail-open input, including the previous-run recovery case and re-run attempts.
`__tests__/engine-db.pg.test.ts` covers the unchanged refetch, each column, and
that the timeout doesn't leak past COMMIT. `__tests__/engine-db-upsert.test.ts`
checks the transaction shape. The staged workflow passes actionlint 1.7.12.

## See also

- [[decision-engine-shadow-mode-first]]
- [[decision-afternoon-pipeline-cron-split]]
