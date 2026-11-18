import { describe, expect, it } from "vitest";
import {
  baselineSurvival,
  baseWidthVersusDepth,
  horizonDisagreement,
  leadershipRollover,
  removeOneDetector,
  signalFragility,
  type DailyBar,
} from "@/lib/shared/se1/bar-only-batch-01";

const bar = (i: number, close: number, volume = 100): DailyBar => ({
  date: `2026-01-${String(i).padStart(2, "0")}`,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume,
});

describe("S26-001 signalFragility", () => {
  it("reports one-factor perturbation stability only with a declared measurement basis", () => {
    const r = signalFragility([bar(1, 10), bar(2, 11)], {
      cutoff: "2026-01-02",
      detector_id: "fixture-detector",
      config_version: "v1",
      uncertainty_basis: "documented_tick_size",
      price_bound: 0.01,
      volume_bound: 1,
      score_tolerance: 0.1,
      evaluate: (bars) => ({ score: bars[1].close!, action: bars[1].close! > 10.5 ? "qualify" : "hold" }),
    });
    expect(r).toMatchObject({ status: "computed", detector_id: "fixture-detector", config_version: "v1" });
    if (r.status === "computed") expect(r.scenario_count).toBeGreaterThan(0);
  });
});

describe("S26-002 removeOneDetector", () => {
  it("shows single-family dominance without treating remaining families as independent", () => {
    const r = removeOneDetector([
      { family: "trend", contribution: 8 },
      { family: "momentum", contribution: 1 },
      { family: "volume", contribution: 1 },
    ], 5);
    expect(r.baseline_score).toBe(10);
    expect(r.omissions.find((item) => item.family === "trend")).toEqual({ family: "trend", score: 2, below_threshold: true });
  });
});

describe("S26-003 horizonDisagreement", () => {
  it("keeps a missing horizon separate from an observed directional disagreement", () => {
    const r = horizonDisagreement([
      { horizon: "short", direction: "up", expected: 5, observed: 5 },
      { horizon: "medium", direction: "down", expected: 10, observed: 8 },
    ], ["short", "medium", "long"]);
    expect(r).toMatchObject({ disagreement: true, horizons: [{ horizon: "short" }, { horizon: "medium" }, { horizon: "long", state: "missing" }] });
  });
});

describe("S26-007 baselineSurvival", () => {
  it("reports every failed chronological and randomized window without choosing the best", () => {
    const r = baselineSurvival([
      { id: "c1", kind: "chronological", sample_size: 10, passed: true },
      { id: "c2", kind: "chronological", sample_size: 10, passed: false },
      { id: "r1", kind: "randomized", sample_size: 10, passed: false },
    ]);
    expect(r).toMatchObject({ failed_windows: ["c2", "r1"], chronological: { total: 2, passed: 1 }, randomized: { total: 1, passed: 0 } });
  });
});

describe("S26-015 baseWidthVersusDepth", () => {
  it("does not call a monotonic falling channel a base", () => {
    const bars = Array.from({ length: 12 }, (_, i) => bar(i + 1, 120 - i * 2));
    expect(baseWidthVersusDepth(bars, { cutoff: "2026-01-12", window: 12, supportBand: 0.01, maxSupportDrift: 0.02 })).toMatchObject({ status: "computed", qualifies: false });
  });
});

describe("S26-019 leadershipRollover", () => {
  it("does not qualify a stock merely because the benchmark rebounded", () => {
    const stock = [1, 2, 3, 4].map((i) => ({ date: `2026-01-0${i}`, close: 80 + i }));
    const benchmark = [1, 2, 3, 4].map((i) => ({ date: `2026-01-0${i}`, close: 80 + i * 2 }));
    expect(leadershipRollover("AAA", "SECTOR", stock, benchmark, { cutoff: "2026-01-04", relativeWindow: 3, longAverageWindow: 4, minOverlap: 3, minResidualSlope: 0.001 })).toMatchObject({ status: "computed", qualifies: false });
  });
});

