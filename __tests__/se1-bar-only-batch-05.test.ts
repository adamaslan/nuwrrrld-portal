import { describe, expect, it } from "vitest";
import {
  crossSectionalVolatilityRankStability,
  failedVolatilityRelease,
  indexStrengthWithNarrowingParticipation,
  postShockVolatilityNormalization,
  volatilityEstimatorDisagreement,
  breadthThrustCoverage,
  type DailyBar,
} from "@/lib/shared/se1/bar-only-batch-05";

const bar = (day: number, close: number, high = close + 1, low = close - 1): DailyBar => ({ date: `2026-05-${String(day).padStart(2, "0")}`, open: close, high, low, close, volume: 100 });

describe("S26-055 failedVolatilityRelease", () => {
  it("dates failure only at reentry into the frozen pre-exit range", () => {
    const r = failedVolatilityRelease([bar(4, 105), bar(5, 104), bar(6, 101)], {
      cutoff: "2026-05-06", releaseDate: "2026-05-04", frozenRange: { startDate: "2026-05-01", endDate: "2026-05-03", high: 102, low: 98 },
    });
    expect(r).toMatchObject({ status: "computed", state: "failed", reentry_date: "2026-05-06", elapsed_bars: 2 });
  });
});

describe("S26-059 postShockVolatilityNormalization", () => {
  it("keeps lower post-shock volatility separate from price recovery", () => {
    const bars = [bar(1, 100), bar(2, 100), bar(3, 100), bar(4, 80), bar(5, 80), bar(6, 80), bar(7, 78)];
    const r = postShockVolatilityNormalization(bars, { cutoff: "2026-05-07", shockDate: "2026-05-04", preShockBandThroughDate: "2026-05-03", atrWindow: 2, preShockAtrPctBand: [0.01, 0.04] });
    expect(r).toMatchObject({ status: "computed", state: "normalized", shock_date: "2026-05-04", price_change_pct: expect.any(Number) });
    if (r.status === "computed") expect(r.price_change_pct).toBeLessThan(0);
  });
});

describe("S26-060 crossSectionalVolatilityRankStability", () => {
  it("ranks only the identical eligible set and counts changed membership and leveraged exclusions", () => {
    const r = crossSectionalVolatilityRankStability([
      { ticker: "AAA", canonicalId: "AAA", priorVolatility: 0.1, currentVolatility: 0.2, priorMember: true, currentMember: true, leveraged: false },
      { ticker: "BBB", canonicalId: "BBB", priorVolatility: 0.2, currentVolatility: 0.1, priorMember: true, currentMember: true, leveraged: false },
      { ticker: "CCC", canonicalId: "CCC", priorVolatility: 0.3, currentVolatility: 0.4, priorMember: true, currentMember: true, leveraged: true },
      { ticker: "DDD", canonicalId: "DDD", priorVolatility: null, currentVolatility: 0.05, priorMember: false, currentMember: true, leveraged: false },
    ]);
    expect(r).toMatchObject({ stable_intersection: 2, exclusions: { membership_changed: 1, leveraged: 1 }, mean_absolute_rank_change: 1 });
  });
});

describe("S26-062 volatilityEstimatorDisagreement", () => {
  it("reports close dispersion, normalized true range and high-low range as separate measures", () => {
    const r = volatilityEstimatorDisagreement([bar(1, 100), bar(2, 102, 106, 98), bar(3, 101, 102, 100)], { cutoff: "2026-05-03", window: 2 });
    expect(r).toMatchObject({ status: "computed", measures: { close_return_dispersion_pct: expect.any(Number), mean_true_range_pct: expect.any(Number), mean_high_low_range_pct: expect.any(Number) }, units: "percent" });
  });
});

describe("S26-063 breadthThrustCoverage", () => {
  it("reports newly eligible strong members separately from fixed-intersection improvement", () => {
    const r = breadthThrustCoverage([
      { ticker: "AAA", priorMember: true, currentMember: true, priorAbove: false, currentAbove: false },
      { ticker: "BBB", priorMember: false, currentMember: true, priorAbove: null, currentAbove: true },
    ]);
    expect(r).toMatchObject({ fixed_intersection_delta: 0, membership_contribution: expect.any(Number), exclusions: { membership_changed: 1 } });
  });
});

describe("S26-066 indexStrengthWithNarrowingParticipation", () => {
  it("uses constituent inputs for breadth and keeps correlated ingredients as components", () => {
    const r = indexStrengthWithNarrowingParticipation([bar(1, 98), bar(2, 99), bar(3, 100)], [
      { ticker: "AAA", sector: "tech", priorMember: true, currentMember: true, priorAboveAverage: true, currentAboveAverage: false, currentRank: 1 },
      { ticker: "BBB", sector: "tech", priorMember: true, currentMember: true, priorAboveAverage: true, currentAboveAverage: false, currentRank: 2 },
      { ticker: "CCC", sector: "health", priorMember: true, currentMember: true, priorAboveAverage: true, currentAboveAverage: true, currentRank: 3 },
    ], { cutoff: "2026-05-03", indexWindow: 3, nearHighRatio: 0.98, topN: 2 });
    expect(r).toMatchObject({ status: "computed", benchmark_near_high: true, breadth_delta: expect.any(Number), components_are_correlated: true });
    if (r.status === "computed") expect(r.breadth_delta).toBeLessThan(0);
  });
});

