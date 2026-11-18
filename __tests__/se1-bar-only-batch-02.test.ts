import { describe, expect, it } from "vitest";
import {
  blowOffExtensionReversal,
  distributionRangeExit,
  failedBreakoutShelfLoss,
  leadershipRankRollover,
  resistanceRejectionCluster,
  successiveHighParticipationDecay,
  type DailyBar,
} from "@/lib/shared/se1/bar-only-batch-02";

const bar = (i: number, close: number, high = close + 1, low = close - 1, volume: number | null = 100): DailyBar => ({
  date: `2026-02-${String(i).padStart(2, "0")}`, open: close, high, low, close, volume,
});

describe("S26-023 failedBreakoutShelfLoss", () => {
  it("flags a close back below the caller-supplied confirmed shelf", () => {
    const r = failedBreakoutShelfLoss([bar(1, 99), bar(2, 102), bar(3, 99), bar(4, 98)], {
      cutoff: "2026-02-04", shelf: 100, holdBars: 3, atrWindow: 2, breakoutBuffer: 0,
    });
    expect(r).toMatchObject({ status: "computed", events: [{ breakout_date: "2026-02-02", state: "failed", failure_date: "2026-02-03" }] });
  });
});

describe("S26-024 successiveHighParticipationDecay", () => {
  it("marks a matched pair unavailable when the intervening volume window has zero volume", () => {
    const bars = [bar(1, 10, 11, 9), bar(2, 12, 13, 11), bar(3, 11, 12, 10, 0), bar(4, 10, 11, 9), bar(5, 13, 14, 12), bar(6, 12, 13, 11)];
    const r = successiveHighParticipationDecay(bars, { cutoff: "2026-02-06", pivotK: 1, minLegBars: 1 });
    expect(r).toMatchObject({ status: "computed", comparisons: [{ state: "unavailable" }], sample_size: 0 });
  });
});

describe("S26-025 leadershipRankRollover", () => {
  it("uses only the stable comparable membership set when ranking both dates", () => {
    const r = leadershipRankRollover([
      { ticker: "AAA", sector: "tech", prior_return: 0.3, current_return: 0.05, prior_member: true, current_member: true },
      { ticker: "BBB", sector: "tech", prior_return: 0.2, current_return: 0.2, prior_member: true, current_member: true },
      { ticker: "CCC", sector: "tech", prior_return: 0.1, current_return: 0.25, prior_member: true, current_member: true },
      { ticker: "DDD", sector: "tech", prior_return: 0.4, current_return: -0.5, prior_member: true, current_member: false },
    ], { cohort_size: 2, sector_returns: { tech: 0.1 }, prior_date: "2026-02-01", current_date: "2026-02-06" });
    expect(r).toMatchObject({ denominator: 3, exclusions: { membership_changed: 1 }, rollovers: [{ ticker: "AAA", prior_rank: 1, current_rank: 3, sector_residual: -0.05 }] });
  });
});

describe("S26-026 blowOffExtensionReversal", () => {
  it("does not label a sustained advance without a later close reversal", () => {
    const bars = [bar(1, 100), bar(2, 100), bar(3, 101), bar(4, 100), bar(5, 100), bar(6, 120), bar(7, 120, 122, 118), bar(8, 121), bar(9, 121)];
    expect(blowOffExtensionReversal(bars, { cutoff: "2026-02-09", baselineWindow: 5, atrWindow: 3, extensionAtr: 3, wideRangeAtr: 2, reversalWindow: 3 })).toMatchObject({ status: "computed", events: [{ reversal_date: null, state: "no_reversal" }] });
  });

  it("pairs a later wide-range close back inside the frozen pre-extension range", () => {
    const bars = [bar(1, 100), bar(2, 100), bar(3, 101), bar(4, 100), bar(5, 100), bar(6, 120), bar(7, 100, 121, 99), bar(8, 101), bar(9, 100)];
    expect(blowOffExtensionReversal(bars, { cutoff: "2026-02-09", baselineWindow: 5, atrWindow: 3, extensionAtr: 3, wideRangeAtr: 2, reversalWindow: 3 })).toMatchObject({ status: "computed", events: [{ reversal_date: "2026-02-07", state: "reversed" }] });
  });
});

describe("S26-027 resistanceRejectionCluster", () => {
  it("preserves confirmation availability and treats breakout-and-hold as contrary evidence", () => {
    const bars = [bar(1, 96, 97), bar(2, 99, 101), bar(3, 97, 97), bar(4, 97, 97), bar(5, 99, 101), bar(6, 103), bar(7, 103)];
    const r = resistanceRejectionCluster(bars, { cutoff: "2026-02-07", resistance: 100, touchTolerance: 0.02, confirmationBars: 2, minSpacing: 2 });
    expect(r).toMatchObject({ status: "computed", attempts: [
      { touch_date: "2026-02-02", available_date: "2026-02-04", outcome: "rejected" },
      { touch_date: "2026-02-05", available_date: "2026-02-07", outcome: "breakout_hold" },
    ] });
  });
});

describe("S26-028 distributionRangeExit", () => {
  it("does not retrospectively call a steadily declining channel a distribution range", () => {
    const bars = Array.from({ length: 12 }, (_, i) => bar(i + 1, 110 - i, 111 - i, 109 - i));
    expect(distributionRangeExit(bars, { cutoff: "2026-02-12", rangeWindow: 10, minDuration: 8, maxResistanceDrift: 0.02, exitBuffer: 0.01, retestWindow: 2 })).toMatchObject({ status: "computed", qualified_range: false, exit: null });
  });

  it("reports a retest after a close exits a previously horizontal range", () => {
    const bars = [
      ...Array.from({ length: 10 }, (_, i) => bar(i + 1, 100, 102, 99)),
      bar(11, 97, 98, 96),
      bar(12, 99, 100, 98),
    ];
    expect(distributionRangeExit(bars, { cutoff: "2026-02-12", rangeWindow: 8, minDuration: 8, maxResistanceDrift: 0.02, exitBuffer: 0.01, retestWindow: 1 })).toMatchObject({ status: "computed", qualified_range: true, exit: { exit_date: "2026-02-11", retest_state: "retested", retest_date: "2026-02-12" } });
  });
});

