---
date: 2026-09-22
type: concept
tags: [observability, pipelines, coverage, status]
sources: [../../lib/shared/run-status.ts, ../../lib/db/schema.sql, ../../lib/pipeline-run-log-db.ts, ../modal-pipeline-status.md, PR#155]
---

# Concept: Run Coverage Status

A pipeline run is not just crash-or-not — it can finish "successfully" while
having done far less than it was supposed to. `docs/modal-pipeline-status.md`
names the concrete case that motivated this: `hydrate-universe` carding
700 of 762 stocks exits with a green workflow, because nothing measured
*coverage*, only whether the process threw.

## The pattern

`lib/shared/run-status.ts`'s `computeRunStatus()` turns `{ expected, filled,
threw, hadFallback, hadEmpty }` into one of four states, checked in this order:

1. **`fail`** — the run threw, regardless of how much it filled before that.
2. **`fail`** — `filled / expected` is below `PARTIAL_COVERAGE_THRESHOLD` (0.95),
   even if nothing threw. A pipeline that quietly wrote 92% of its universe
   and returned 200 is a failure, not a success.
3. **`partial`** — filled some but not all, at or above the 0.95 ratio.
4. **`degraded`** — fully filled, but a `FREE_MODEL_CHAIN` fallback served at
   least one item, or an item came back `empty`. Model-quality signal, not a
   coverage gap — [[concept-free-tier-resilience]]'s Layer 6 already tracks
   this via `RunItem.fallback`, `run-status.ts` just folds it into one column.
5. **`ok`** — fully filled, no substitution.

`partial` and `fail` are meant to open/update the existing `pipeline-failure`
GitHub issue, the same way each workflow's `notify` job already does.
`degraded` does not page anyone — it shows up in the daily report instead.

## Where it appears

The `status` value is stored on [[entity-model-usage-log|`pipeline_run_log`]]'s
new `status` column (`host`/`status`/`coverage`, PR #155), alongside a
`coverage` jsonb blob (`{ expected, filled, missing, missingCount,
staleCount }`).

**Wired up 2026-09-22 (PR #158, Phase 4):** `hydrate-universe` is the first
real caller of `computeRunStatus()`, logging once per POST chunk with
`coverage` scoped to that chunk's own universe (`coverageForUniverseAndDate()`
in `ticker-cards-db.ts` — stocks and ETFs post separately, so a whole-universe
`expected` would misreport either lane). Verified against a live 2-symbol
run: `status: "fail"` at 2/762 filled, correctly below the 0.95 threshold.
See [[entity-ticker-universe-pipeline]] failure 16 for the full change.

`run-status.ts` is pure and dependency-free by the same rule as
[[concept-followed-tickers-tracking|universe-policy.ts]] and its siblings: no
`DATABASE_URL` import, so the status table's edge cases (exact threshold
ratio, `expected: 0`, throw-with-full-coverage) are unit-tested directly
rather than only reachable through a live pipeline run.

## Contradictions / tensions

- The classifier treats `expected: 0` as automatically `ok` (a pipeline with
  nothing to do can't be short of coverage). That's correct for a genuinely
  empty run, but it's indistinguishable from a caller passing the wrong
  `expected` value (e.g. a universe-count query that silently returned 0) —
  the same "ran, logged nothing" ambiguity already flagged under
  [[entity-model-usage-log]]'s Known failures, just moved one level up.
- One fixed `PARTIAL_COVERAGE_THRESHOLD` (0.95) applies uniformly across every
  pipeline, in tension with the fact that `hydrate-universe` (762 stocks,
  natural per-symbol vendor flakiness) and `paper-portfolios` (8 fixed
  accounts, no such flakiness expected) have very different tolerances for
  what "a few missing" should mean.

## Open questions

- ❓ Now that `hydrate-universe` writes `status`, should the nulogdash
  pipelines tab (`/dashboard/nulogdash/pipelines`) surface it as a badge next
  to the existing outcome counts, or is a filter/column enough for v1?
- ❓ Does the fixed 0.95 threshold survive contact with real
  `hydrate-universe` data at full-universe scale — the only run tested so far
  is a manual 2-symbol smoke test, not a real nightly chunk sequence — or does
  it need a per-pipeline override?

## See also

- [[entity-model-usage-log]] — the table this status lands on
- [[concept-free-tier-resilience]] — `degraded`'s model-substitution half
- `docs/modal-pipeline-status.md` — Design 1, the source of the status table
