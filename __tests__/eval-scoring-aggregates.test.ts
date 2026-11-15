import { describe, expect, it } from "vitest";
import {
  aggregate,
  MIN_RESOLVED_FOR_RATE,
  type Outcome,
  type ScoredPick,
} from "@/lib/eval-scoring";

/**
 * T-117: hit-rate is computed only over resolved, non-void picks; voids and
 * flats are excluded from the denominator and counted visibly, and a rate
 * over fewer than MIN_RESOLVED_FOR_RATE decisive picks is reported as null,
 * never as a flattering small-n number.
 */

const pick = (outcome: Outcome, directional: number): ScoredPick => ({
  outcome,
  returnPct: directional,
  directional,
});

const repeat = (outcome: Outcome, directional: number, count: number): ScoredPick[] =>
  Array.from({ length: count }, () => pick(outcome, directional));

describe("aggregate denominator excludes voids and flats (T-117)", () => {
  it("voids are excluded from the rate and counted visibly", () => {
    // 15 hits + 15 misses + 10 voids. If voids leaked into the denominator
    // the rate would be 15/40 = 37.5; correct is 15/30 = 50.
    const a = aggregate([
      ...repeat("hit", 10, 15),
      ...repeat("miss", -10, 15),
      ...repeat("void", 0, 10),
    ]);
    expect(a.n).toBe(30);
    expect(a.voids).toBe(10);
    expect(a.hitRatePct).toBe(50);
  });

  it("flats are excluded from the rate and counted visibly", () => {
    // 20 hits + 10 misses + 70 flats: rate over the 30 decisive picks only.
    const a = aggregate([
      ...repeat("hit", 10, 20),
      ...repeat("miss", -10, 10),
      ...repeat("flat", 1, 70),
    ]);
    expect(a.n).toBe(30);
    expect(a.flats).toBe(70);
    expect(a.hitRatePct).toBeCloseTo((20 / 30) * 100, 10);
  });

  it("mean directional return runs over decisive picks only", () => {
    // The flat carries a huge directional value: if flats leaked into the
    // mean it would move off (10 + -4) / 2 = 3.
    const a = aggregate([
      pick("hit", 10),
      pick("miss", -4),
      pick("flat", 999),
      pick("void", 0),
    ]);
    expect(a.meanDirectionalPct).toBe(3);
  });
});

describe("n < MIN_RESOLVED_FOR_RATE honesty rule (T-117)", () => {
  it("29 decisive picks: hitRatePct is null", () => {
    const a = aggregate([...repeat("hit", 10, 15), ...repeat("miss", -10, 14)]);
    expect(a.n).toBe(MIN_RESOLVED_FOR_RATE - 1);
    expect(a.hitRatePct).toBeNull();
  });

  it("30 decisive picks: hitRatePct is computed", () => {
    const a = aggregate([...repeat("hit", 10, 15), ...repeat("miss", -10, 15)]);
    expect(a.n).toBe(MIN_RESOLVED_FOR_RATE);
    expect(a.hitRatePct).toBe(50);
  });

  it("an all-flat/void cohort reports nulls, not 0% or 100%", () => {
    const a = aggregate([...repeat("flat", 1, 10), ...repeat("void", 0, 5)]);
    expect(a.n).toBe(0);
    expect(a.hitRatePct).toBeNull();
    expect(a.meanDirectionalPct).toBeNull();
  });
});
