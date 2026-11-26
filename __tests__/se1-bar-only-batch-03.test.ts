import { describe, expect, it } from "vitest";
import {
  crossoverSurvivalInput,
  defensiveSectorRotation,
  horizonDisagreementAge,
  movingAverageStackRepair,
  rallyRepairFailure,
  transitionAfterLongAverageReclaim,
  type DailyBar,
} from "@/lib/shared/se1/bar-only-batch-03";

const bar = (day: number, close: number): DailyBar => ({ date: `2026-03-${String(day).padStart(2, "0")}`, open: close, high: close + 1, low: close - 1, close, volume: 100 });

describe("S26-029 defensiveSectorRotation", () => {
  it("compares the declared ETF baskets on a common total-return basis near an index high", () => {
    const dates = [1, 2, 3, 4].map((day) => `2026-03-0${day}`);
    const series = (ticker: string, category: "defensive" | "cyclical", closes: number[]) => ({
      ticker, category, weight: 1, basis: "total_return" as const, bars: closes.map((close, i) => ({ date: dates[i], close })),
    });
    const r = defensiveSectorRotation([
      series("XLU", "defensive", [90, 91, 93, 99]),
      series("XLY", "cyclical", [90, 91, 92, 93]),
    ], dates.map((date, i) => ({ date, close: 100 + i })), { cutoff: dates[3], indexWindow: 4, nearHighRatio: 0.95 });
    expect(r).toMatchObject({ status: "computed", broad_index_near_high: true, spread_pct: expect.any(Number), missing_legs: [] });
    if (r.status === "computed") expect(r.spread_pct).toBeGreaterThan(0);
  });
});

describe("S26-030 horizonDisagreementAge", () => {
  it("keeps a confirmed divergence pending in a strong trend instead of predicting reversal", () => {
    const points = [
      { date: "2026-03-01", price: 10, oscillator: 60 }, { date: "2026-03-02", price: 12, oscillator: 70 },
      { date: "2026-03-03", price: 11, oscillator: 62 }, { date: "2026-03-04", price: 13, oscillator: 68 },
      { date: "2026-03-05", price: 14, oscillator: 65 }, { date: "2026-03-06", price: 13, oscillator: 63 },
      { date: "2026-03-07", price: 15, oscillator: 66 },
    ];
    expect(horizonDisagreementAge(points, { cutoff: "2026-03-07", pivotK: 1, weaknessBuffer: 0.05 })).toMatchObject({ status: "computed", divergences: [{ state: "pending", age: 1 }] });
  });
});

describe("S26-031 rallyRepairFailure", () => {
  it("does not timestamp at the first break and marks a later failed repair", () => {
    const r = rallyRepairFailure([bar(1, 99), bar(2, 95), bar(3, 93), bar(4, 97), bar(5, 92)], {
      cutoff: "2026-03-05", confirmed_higher_low: { level: 100, confirmed_date: "2026-03-01" },
    });
    expect(r).toMatchObject({ status: "computed", events: [{ break_date: "2026-03-02", state: "failed_repair", invalidation_date: "2026-03-05" }] });
  });
});

describe("S26-033 movingAverageStackRepair", () => {
  it("does not treat one cross as completion of the full price/average stack", () => {
    const bars = [20, 18, 16, 14, 12, 10, 8, 9, 10, 11, 12].map((close, i) => bar(i + 1, close));
    expect(movingAverageStackRepair(bars, { cutoff: "2026-03-08", shortWindow: 2, mediumWindow: 3, longWindow: 5 })).toMatchObject({ status: "computed", transitions: [{ state: "incomplete" }] });
  });
});

describe("S26-034 crossoverSurvivalInput", () => {
  it("records recross events and keeps end-of-history crossovers right-censored", () => {
    const bars = [6, 5, 4, 3, 4, 5, 3, 2, 3, 4, 5].map((close, i) => bar(i + 1, close));
    const r = crossoverSurvivalInput(bars, { cutoff: "2026-03-11", fastWindow: 2, slowWindow: 3, holdBars: 5, splitDate: "2026-03-07" });
    expect(r).toMatchObject({ status: "computed", events: [{ status: "recrossed", split: "training" }, { status: "right_censored", split: "holdout", censoring_reason: "decision_cutoff" }] });
  });
});

describe("S26-036 transitionAfterLongAverageReclaim", () => {
  it("dates a higher low only when its confirmation bars have arrived", () => {
    const bars = [12, 10, 8, 8.5, 11, 10, 12].map((close, i) => bar(i + 1, close));
    const r = transitionAfterLongAverageReclaim(bars, { cutoff: "2026-03-07", longWindow: 3, pivotK: 1 });
    expect(r).toMatchObject({ status: "computed", events: [{ reclaim_date: "2026-03-05", state: "higher_low_confirmed", higher_low_available_date: "2026-03-07" }] });
  });
});

