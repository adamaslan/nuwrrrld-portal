import { describe, it, expect } from "vitest";
import { pathEfficiency, rangeWithoutCloseProgress, type OhlcBar } from "@/lib/shared/se1/trend-vol-scans";

const b = (date: string, h: number, l: number, c: number): OhlcBar => ({ date, open: null, high: h, low: l, close: c });

describe("review: rangeWithoutCloseProgress path_efficiency is bounded by 1", () => {
  it("monotonic 10% compounding closes give efficiency ~1, never above", () => {
    const bars = [
      b("2026-01-01", 101, 99, 100),
      b("2026-01-02", 111, 108, 110),
      b("2026-01-03", 122, 119, 121),
      b("2026-01-04", 134, 131, 133.1),
    ];
    const r = rangeWithoutCloseProgress(bars, "2026-01-04", 4);
    if (r.status !== "computed" || r.path_efficiency === null) throw new Error("expected computed with efficiency");
    expect(r.path_efficiency).toBeLessThanOrEqual(1);
    expect(r.path_efficiency).toBeCloseTo(1, 12);
    expect(r.net_close_displacement_pct).toBeCloseTo(33.1, 10);
  });
});


describe("historical cutoff validation", () => {
  it("does not validate OHLC values strictly after the cutoff", () => {
    const bars: OhlcBar[] = [
      b("2026-01-01", 101, 99, 100),
      b("2026-01-02", 102, 100, 101),
      { date: "2026-01-03", open: null, high: Infinity, low: 99, close: 102 },
    ];
    expect(pathEfficiency(bars, "2026-01-02", 2)).toMatchObject({ status: "computed" });
  });
});
