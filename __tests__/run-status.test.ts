/**
 * run-status — unit tests for the pipeline run-status classifier.
 *
 * Runs without DATABASE_URL by design: run-status.ts is pure, the same
 * reason universe-policy.test.ts runs without it.
 */
import { describe, expect, it } from "vitest";
import {
  PARTIAL_COVERAGE_THRESHOLD,
  computeBatchCoverage,
  computeRunStatus,
  deriveRunStatus,
} from "@/lib/shared/run-status";

describe("computeRunStatus", () => {
  it("is ok when fully filled with no model substitution", () => {
    expect(computeRunStatus({ expected: 54, filled: 54 })).toBe("ok");
  });

  it("is ok when there is nothing to do (expected 0)", () => {
    expect(computeRunStatus({ expected: 0, filled: 0 })).toBe("ok");
  });

  it("is degraded when fully filled but a fallback model served", () => {
    expect(computeRunStatus({ expected: 54, filled: 54, hadFallback: true })).toBe("degraded");
  });

  it("is degraded when fully filled but an item came back empty", () => {
    expect(computeRunStatus({ expected: 54, filled: 54, hadEmpty: true })).toBe("degraded");
  });

  it("is partial at exactly the threshold ratio", () => {
    const expected = 100;
    const filled = expected * PARTIAL_COVERAGE_THRESHOLD;
    expect(computeRunStatus({ expected, filled })).toBe("partial");
  });

  it("is partial just above the threshold", () => {
    expect(computeRunStatus({ expected: 762, filled: 730 })).toBe("partial"); // ~0.958
  });

  it("is fail just below the threshold", () => {
    expect(computeRunStatus({ expected: 762, filled: 700 })).toBe("fail"); // ~0.919
  });

  it("is fail when the run threw, even with full coverage", () => {
    expect(computeRunStatus({ expected: 54, filled: 54, threw: true })).toBe("fail");
  });

  it("is fail when the run threw with zero coverage", () => {
    expect(computeRunStatus({ expected: 8, filled: 0, threw: true })).toBe("fail");
  });

  it("degraded takes no effect when coverage alone is already partial or fail", () => {
    expect(computeRunStatus({ expected: 762, filled: 700, hadFallback: true })).toBe("fail");
    expect(computeRunStatus({ expected: 762, filled: 730, hadFallback: true })).toBe("partial");
  });
});

describe("computeBatchCoverage", () => {
  it("grades a clean batch ok even when it is a small slice of a large universe", () => {
    // The 2026-10 defect: 68 clean rows of a 1,008-ticker run were stamped
    // `fail` because they were graded against the whole universe.
    const tickers = Array.from({ length: 68 }, (_, i) => `T${i}`);
    const coverage = computeBatchCoverage(tickers, new Set(), new Set());
    expect(coverage).toEqual({ expected: 68, filled: 68 });
    expect(computeRunStatus(coverage)).toBe("ok");
  });

  it("dedupes tickers (a ticker carries one card per horizon)", () => {
    expect(computeBatchCoverage(["A", "A", "B"], new Set(), new Set())).toEqual({ expected: 2, filled: 2 });
  });

  it("counts failed writes and upstream errors as unfilled", () => {
    const coverage = computeBatchCoverage(["A", "B", "C", "D"], new Set(["B"]), new Set(["C"]));
    expect(coverage).toEqual({ expected: 4, filled: 2 });
    expect(computeRunStatus(coverage)).toBe("fail");
  });

  it("an empty batch is ok, not a division error", () => {
    expect(computeRunStatus(computeBatchCoverage([], new Set(), new Set()))).toBe("ok");
  });
});

describe("deriveRunStatus", () => {
  it("is ok when every attempted item succeeded", () => {
    expect(deriveRunStatus([{ outcome: "ok" }, { outcome: "ok" }])).toBe("ok");
  });

  it("is ok when nothing was attempted (all skipped, or no items)", () => {
    expect(deriveRunStatus([{ outcome: "skip" }])).toBe("ok");
    expect(deriveRunStatus([])).toBe("ok");
  });

  it("is fail when nothing generated — the precompute 0/10 shape", () => {
    expect(deriveRunStatus(Array.from({ length: 10 }, () => ({ outcome: "fail" as const })))).toBe("fail");
  });

  it("is degraded when everything succeeded but a fallback served", () => {
    expect(deriveRunStatus([{ outcome: "ok", fallback: true }, { outcome: "ok" }])).toBe("degraded");
  });

  it("never returns a nullish status", () => {
    for (const items of [[], [{ outcome: "empty" as const }], [{ outcome: "skip" as const }]]) {
      expect(deriveRunStatus(items)).toMatch(/^(ok|degraded|partial|fail)$/);
    }
  });
});
