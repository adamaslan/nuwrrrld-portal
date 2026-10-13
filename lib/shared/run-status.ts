/**
 * run-status — pure, dependency-free status classification for a pipeline run.
 *
 * Implements the Design 1 status table in docs/modal-pipeline-status.md: a
 * run reports coverage (expected vs. filled), not just crash/no-crash, and
 * this function turns that coverage into the one `status` column value that
 * decides whether the run pages anyone.
 *
 * Split out the same way lib/shared/universe-policy.ts is split from its
 * *-db.ts sibling: no I/O, so it's unit-testable without DATABASE_URL.
 */

/** `filled / expected` at or above this still counts as `partial`, not `fail`. */
export const PARTIAL_COVERAGE_THRESHOLD = 0.95;

export type RunStatus = "ok" | "degraded" | "partial" | "fail";

export interface RunStatusInput {
  expected: number;
  filled: number;
  /** True when the run threw before finishing — always `fail`, regardless of coverage. */
  threw?: boolean;
  /** True when a FREE_MODEL_CHAIN fallback served at least one item. */
  hadFallback?: boolean;
  /** True when at least one item's outcome was `empty`. */
  hadEmpty?: boolean;
}

/**
 * Classify a run's outcome.
 *
 * Order matters: a throw is always `fail` regardless of coverage; a coverage
 * ratio below the partial threshold is always `fail` regardless of model
 * health; only a fully-filled run can be `degraded`; everything else is `ok`.
 */
export function computeRunStatus(input: RunStatusInput): RunStatus {
  const { expected, filled, threw = false, hadFallback = false, hadEmpty = false } = input;

  if (threw) return "fail";

  // A pipeline with nothing to do (expected === 0) can't be short of coverage.
  const ratio = expected > 0 ? filled / expected : 1;
  if (ratio < PARTIAL_COVERAGE_THRESHOLD) return "fail";
  if (filled < expected) return "partial";

  if (hadFallback || hadEmpty) return "degraded";
  return "ok";
}

/** The slice of a run item that status derivation needs (a structural subset of RunItem). */
export interface StatusItem {
  outcome: "ok" | "empty" | "fail" | "skip";
  fallback?: boolean;
}

/**
 * Derive a status from item outcomes, for callers that did not compute one.
 *
 * `logPipelineRun` applies this so a row can never be written with a null
 * status: 27 precompute-ai rows and 6 others were, which hid them from every
 * query that filters on `status`. `skip` means "no attempt was made" and is
 * neutral, so a run that attempted nothing is `ok`, not `fail`.
 */
export function deriveRunStatus(items: readonly StatusItem[]): RunStatus {
  const attempted = items.filter((it) => it.outcome !== "skip");
  return computeRunStatus({
    expected: attempted.length,
    filled: attempted.filter((it) => it.outcome === "ok").length,
    hadFallback: attempted.some((it) => it.fallback === true),
    hadEmpty: attempted.some((it) => it.outcome === "empty"),
  });
}

export interface BatchCoverage {
  expected: number;
  filled: number;
}

/**
 * Coverage of ONE hydrate batch against the tickers it carried.
 *
 * The route used to grade every batch against the whole universe's coverage
 * for the bar date. A chunked run posts ~30 batches, so each early batch saw
 * "expected 1,008, filled 68" and was stamped `fail` even with `failed: 0` —
 * 28 of 30 rows every night. A batch is now judged on what it was asked to
 * write; whole-universe coverage is still recorded (as data), not graded here.
 *
 * `expected` = valid tickers in the request (written, failed, or reported as
 * an upstream error). `filled` = those with no failed card write and no
 * upstream error. Rejected tickers (crypto-shaped, malformed) are excluded:
 * they were never writable. Unservable tickers (vendor has no bars) are
 * likewise left out of `requestedTickers` by the caller.
 */
export function computeBatchCoverage(
  requestedTickers: readonly string[],
  failedTickers: ReadonlySet<string>,
  upstreamErrorTickers: ReadonlySet<string>,
): BatchCoverage {
  const expected = new Set(requestedTickers);
  let filled = 0;
  for (const ticker of expected) {
    if (!failedTickers.has(ticker) && !upstreamErrorTickers.has(ticker)) filled += 1;
  }
  return { expected: expected.size, filled };
}
