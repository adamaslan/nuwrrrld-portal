/**
 * run-status — unit tests for the pipeline run-status classifier.
 *
 * Runs without DATABASE_URL by design: run-status.ts is pure, the same
 * reason universe-policy.test.ts runs without it.
 */
import { describe, expect, it } from "vitest";
import { PARTIAL_COVERAGE_THRESHOLD, computeRunStatus } from "@/lib/shared/run-status";

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
