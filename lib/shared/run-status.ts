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
