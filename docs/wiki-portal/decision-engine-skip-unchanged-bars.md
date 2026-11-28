---
date: 2026-11-27
type: decision
tags: [engine, neon, transfer, watermark, scheduled-jobs, daily-bars]
sources: [../../lib/engine-db.ts, ../../app/api/pipeline/engine-run/route.ts, ../../scripts/engine-run.mjs, ../../.github/workflows/engine-nightly.yml, ../../__tests__/engine-db.pg.test.ts, ../../__tests__/engine-run-watermark.test.ts]
---

# Decision — Skip the Shadow Engine Recompute When Its Bars Have Not Changed

## Decision

A shadow engine run does not re-read bars or rewrite structure when an earlier
**complete** run already computed from exactly the bars stored now. The check is
a content watermark in the database, not a guess about which cron fired:

- `upsertBars` rewrites a stored bar only when a non-key column (OHLCV,
  `adjustment`, `source`) changed. `daily_bars.fetched_at` therefore means "the
  last time this row's content was inserted or changed", and a changed row
  still gets the database's `now()`.
- Each `engine_runs` row records a fingerprint of the active ticker set when it
  starts. The last chunk marks the run complete only if that set is unchanged.
- On its first shadow chunk, `/api/pipeline/engine-run` with
  `skipIfUnchanged: true` answers `status: "unchanged"` when a run exists with
  the same code version and feed, marked complete over the current active set,
  reporting every active ticker with zero failures, and started after the
  newest `fetched_at` for that feed. `scripts/engine-run.mjs` opts in, logs
  `[skip]` and `[done] … status=unchanged coveredBy=<run>`, still runs
  labeling, and takes `--force`.

## Date

2026-11-27

## Context

`engine-nightly.yml` runs on `workflow_run` of the hydration workflow, which
has two crons. GitHub fires the midday cron hours late, often after the close;
the intraday lane then skips (`status=skipped written=0`) yet the workflow
concludes success, so the engine runs anyway. Run history for 2026-11-14 to
2026-11-27 shows two engine runs per trading day. The 2026-11-25 23:25 UTC and
2026-11-26 04:18 UTC runs produced the same totals (996 snapshots, 146 hits).
Each run's `loadSeries` reads up to 300 bars for every active ticker. Which of
the two runs is the redundant one depends on how late GitHub fires, so gating
on the triggering cron would be fragile.

Run history also showed the duplicated paper-portfolio entries (about ten per
weekday) stop in the gate job, which never touches Neon, so they were not the
target. Hydration and engine-bars fetch from Alpaca, not Neon.

On a local Postgres workload (1,033 tickers, 320 bars each), the late midday
run went from 21 queries / 310,936 rows / about 47.9 MB of serialized JSON
results to 1 query / 1 row / 44 bytes. The nightly run added 2 small queries.
An identical trailing-week refetch stopped restamping 6,198 rows. These are
local JSON-result estimates, not Neon billed transfer; no monthly saving is
claimed.

## Alternatives considered

- **Run the engine only after the nightly cron.** A live workflow change, and
  wrong whenever the midday cron fires after the close, as it often does,
  and computes the new bar first.
- **Skip when hydration reports `status=skipped`.** Hydration and engine-bars
  are independent; a skipped intraday lane can still precede new settled bars.
- **Fingerprint the bars themselves each run.** Correct, but it scans the
  history for every run and needs somewhere to store the hash.
- **Match on ticker count only.** Rejected during testing: a partial run plus a
  universe that shrank by the same number looked complete.

## Consequences

- Fails open: no earlier run, a partial or unfinished run, any failed ticker,
  a different code version or feed, a changed active set, a new or revised bar,
  live mode, an explicit `asOf`, a later chunk, or callers that do not opt in
  all recompute. A watermark lookup error returns 500, never `unchanged`.
- Runs recorded before this change have no completion flag, so the first run
  after deploy recomputes.
- Relies on bar writes not overlapping a run: `engine-nightly`'s concurrency
  group fetches bars, then runs the engine, one workflow at a time.
- The incremental backup work (PR #458) reads `fetched_at` as its delta. It
  stays complete because every content change still stamps `now()`, and
  unchanged refetches no longer inflate the delta.
- Labeling (`engine-label`) still runs every time; its diagnostics query is
  unchanged.

## Validated by

`__tests__/engine-db.pg.test.ts` (local Postgres: unchanged refetch, each
column, late midday cron, late data, partial/failed/short runs, universe swap
and mid-run change, code version, overlapping runs) and
`__tests__/engine-run-watermark.test.ts` (route and script paths). Both fail
on base `c055c3f` and pass on the branch.

## See also

- [[decision-engine-shadow-mode-first]]
- [[decision-afternoon-pipeline-cron-split]]
