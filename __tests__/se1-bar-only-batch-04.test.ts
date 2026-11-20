import { describe, expect, it } from "vitest";
import {
  closeLocationAroundSupport,
  compressionDurationPercentile,
  longTrendSlopeCurvature,
  momentumResetWithoutStructureBreak,
  pullbackDepthConsistency,
  squeezeReleaseAmbiguity,
  type DailyBar,
} from "@/lib/shared/se1/bar-only-batch-04";

const bar = (day: number, close: number, high = close + 1, low = close - 1): DailyBar => ({ date: `2026-04-${String(day).padStart(2, "0")}`, open: close, high, low, close, volume: 100 });

describe("S26-037 pullbackDepthConsistency", () => {
  it("reports percentage and ATR depth separately for confirmed higher-high pullbacks", () => {
    const bars = [100, 110, 105, 115, 108, 120, 114, 118].map((close, i) => bar(i + 1, close));
    const r = pullbackDepthConsistency(bars, { cutoff: "2026-04-08", pivotK: 1, atrWindow: 2 });
    expect(r).toMatchObject({ status: "computed", pullbacks: expect.any(Array), comparison: { percentage_depth_expanding: expect.any(Boolean) } });
    if (r.status === "computed" && r.pullbacks) expect(r.pullbacks.length).toBeGreaterThanOrEqual(2);
  });
});

describe("S26-038 closeLocationAroundSupport", () => {
  it("uses the fixed caller band and reports occupancy and transitions", () => {
    const r = closeLocationAroundSupport([100, 101, 100, 102, 98, 100].map((close, i) => bar(i + 1, close)), {
      cutoff: "2026-04-06", movingAverageWindow: 3, bandPct: 0.01,
    });
    expect(r).toMatchObject({ status: "computed", band_pct: 0.01, counts: { above: expect.any(Number), inside: expect.any(Number), below: expect.any(Number) }, transitions: expect.any(Number) });
  });
});

describe("S26-039 longTrendSlopeCurvature", () => {
  it("compares causal rolling slopes and marks near-zero slopes uncertain", () => {
    const r = longTrendSlopeCurvature([10, 11, 12, 14, 17, 21].map((close, i) => bar(i + 1, close)), {
      cutoff: "2026-04-06", window: 3, nearZeroSlope: 0.01,
    });
    expect(r).toMatchObject({ status: "computed", current_slope: expect.any(Number), prior_slope: expect.any(Number), unit: "price_per_bar", overlap_bars: 2 });
    if (r.status === "computed") expect(r.acceleration).toBeGreaterThan(0);
  });
});

describe("S26-040 momentumResetWithoutStructureBreak", () => {
  it("does not flag before momentum reaccelerates after support survives", () => {
    const r = momentumResetWithoutStructureBreak([10, 11, 12, 11.5, 12, 13, 14].map((close, i) => bar(i + 1, close)), {
      cutoff: "2026-04-07", momentumWindow: 2, support: 10.5, resetMax: 0.05, restartMin: 0.08, trendContext: "up",
    });
    expect(r).toMatchObject({ status: "computed", state: "restarted", reset_date: expect.any(String), restart_date: "2026-04-06", support_survived: true });
  });
});

describe("S26-053 compressionDurationPercentile", () => {
  it("compares an unfinished current run only with earlier completed runs", () => {
    const bars = [bar(1, 100, 101, 99), bar(2, 100, 101, 99), bar(3, 100, 101, 99), bar(4, 100, 110, 90), bar(5, 100, 101, 99), bar(6, 100, 101, 99)];
    expect(compressionDurationPercentile(bars, { cutoff: "2026-04-06", compressionWidth: 0.03, minCompletedRuns: 1 })).toMatchObject({ status: "computed", current_run: 2, completed_run_lengths: [3], percentile: 0 });
  });
});

describe("S26-054 squeezeReleaseAmbiguity", () => {
  it("does not infer direction from range expansion while the close remains inside the prior range", () => {
    const bars = [bar(1, 100), bar(2, 100), bar(3, 100), bar(4, 100), bar(5, 100, 110, 90), bar(6, 100)];
    expect(squeezeReleaseAmbiguity(bars, { cutoff: "2026-04-06", bandwidthWindow: 3, minimumExpansion: 1.5 })).toMatchObject({ status: "computed", state: "ambiguous_inside", bandwidth_expansion: expect.any(Number) });
  });
});

