import { describe, expect, it } from "vitest";

import golden from "./fixtures/fib-golden.json";
import { buildFrame, labelHit, sliceFrame, snapshotFrame, type Bar } from "@/lib/engine";

type GoldenSeries = {
  name: string;
  ohlcv: number[][];
  bars: Array<{ signals?: Array<{ signal: string }> }>;
};
const series = (golden as { series: GoldenSeries[] }).series;
const toBars = (o: number[][]): Bar[] =>
  o.map(([open, high, low, close, volume]) => ({ open, high, low, close, volume }));

function findDefaultHold(): { frame: ReturnType<typeof buildFrame>; index: number } {
  for (const s of series) {
    const index = s.bars.findIndex((b) => (b.signals ?? []).some((x) => x.signal === "FIB GOLDEN POCKET HOLD"));
    if (index >= 0) return { frame: sliceFrame(buildFrame(toBars(s.ohlcv)), index), index };
  }
  throw new Error("fixture has no default hold");
}

describe("snapshotFrame", () => {
  it("orders support below and resistance above the close", () => {
    for (const s of series) {
      const full = buildFrame(toBars(s.ohlcv));
      const snap = snapshotFrame(sliceFrame(full, s.ohlcv.length - 1));
      if (snap.nearestSupport !== null) expect(snap.nearestSupport).toBeLessThan(snap.close);
      if (snap.nearestResistance !== null) expect(snap.nearestResistance).toBeGreaterThan(snap.close);
      expect(snap.levels.length === 0 || snap.levels.length === 7).toBe(true);
    }
  });

  it("reports the default hold with stop below the pocket and target at the leg high", () => {
    const { frame } = findDefaultHold();
    const snap = snapshotFrame(frame);
    const hold = snap.hits.find((h) => h.signal === "FIB GOLDEN POCKET HOLD" && !h.experimental);
    expect(hold).toBeDefined();
    const f = hold!.features;
    expect(f.stop as number).toBeLessThan(f.entry as number);
    expect(f.target as number).toBeGreaterThan(f.entry as number);
    expect(f.target).toBe(f.leg_high);
    expect(f.reward_risk as number).toBeGreaterThan(0);
  });

  it("returns an empty ladder when there is no leg", () => {
    const flat: Bar[] = Array.from({ length: 60 }, () => ({ open: 10, high: 10.1, low: 9.9, close: 10, volume: 100 }));
    const snap = snapshotFrame(buildFrame(flat));
    expect(snap.levels).toEqual([]);
    expect(snap.swingAnchor).toBeNull();
    expect(snap.hits).toEqual([]);
  });
});

describe("labelHit", () => {
  const bar = (high: number, low: number, close: number): Bar => ({ open: close, high, low, close, volume: 1 });
  const quiet = (n: number): Bar[] => Array.from({ length: n }, () => bar(101, 99, 100));

  it("returns null until the horizon has elapsed", () => {
    expect(labelHit({ entry: 100, futureBars: quiet(20) })).toBeNull();
  });

  it("labels a target hit as +R", () => {
    const bars = [...quiet(3), bar(112, 99, 111), ...quiet(20)];
    const label = labelHit({ entry: 100, stop: 95, target: 110, futureBars: bars })!;
    expect(label.outcome).toBe("target");
    expect(label.pctReturn).toBeCloseTo(10);
    expect(label.rMultiple).toBeCloseTo(2);
    expect(label.hit).toBe(true);
  });

  it("checks the stop first when one bar touches both barriers", () => {
    const bars = [bar(112, 94, 100), ...quiet(25)];
    const label = labelHit({ entry: 100, stop: 95, target: 110, futureBars: bars })!;
    expect(label.outcome).toBe("stop");
    expect(label.rMultiple).toBeCloseTo(-1);
    expect(label.hit).toBe(false);
  });

  it("falls back to the horizon close for a time exit", () => {
    const bars = [...quiet(20), bar(103, 101, 102)];
    const label = labelHit({ entry: 100, stop: 95, target: 110, futureBars: bars })!;
    expect(label.outcome).toBe("time");
    expect(label.pctReturn).toBeCloseTo(2);
  });

  it("has no barrier outcome when the hit defines no stop or target", () => {
    const label = labelHit({ entry: 100, futureBars: quiet(21) })!;
    expect(label.outcome).toBeNull();
    expect(label.rMultiple).toBeNull();
  });
});
