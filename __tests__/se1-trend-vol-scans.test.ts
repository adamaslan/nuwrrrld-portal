import { describe, expect, it } from "vitest";
import {
  breakdownDistance, gapSessionComponents, newHighLowBalance, pathEfficiency, rangeWithoutCloseProgress,
  semivarianceBalance, type OhlcBar,
} from "@/lib/shared/se1/trend-vol-scans";

/** S26-035, 056, 057, 058, 061, 065 fixtures. Pure bars, no feed. */
const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
const ohlc = (i: number, o: number | null, h: number | null, l: number | null, c: number | null): OhlcBar =>
  ({ date: day(i), open: o, high: h, low: l, close: c });

describe("S26-035 pathEfficiency", () => {
  it("reads a straight trend as efficient and alternating equal moves as inefficient", () => {
    const straight = [1, 2, 3, 4, 5].map((i) => ohlc(i, null, null, null, 100 + i));
    const chop = [1, 2, 3, 4, 5].map((i) => ohlc(i, null, null, null, i % 2 === 0 ? 100 : 101));
    const a = pathEfficiency(straight, day(5), 5);
    const b = pathEfficiency(chop, day(5), 5);
    expect(a).toMatchObject({ status: "computed", efficiency: 1 });
    if (b.status !== "computed" || b.efficiency === null) throw new Error("unexpected");
    expect(b.efficiency).toBeLessThan(0.3);
  });

  it("gives an explicit undefined state for a zero path, not an efficiency of zero", () => {
    const flat = [1, 2, 3].map((i) => ohlc(i, null, null, null, 100));
    expect(pathEfficiency(flat, day(3), 3)).toMatchObject({ status: "computed", efficiency: null, undefined_reason: "zero path length" });
  });
});

describe("S26-056 semivarianceBalance", () => {
  it("splits squared returns by sign and reports the counts behind them", () => {
    const bars = [1, 2, 3].map((i) => ohlc(i, null, null, null, 100));
    bars[1] = ohlc(2, null, null, null, 110); // +10%
    bars[2] = ohlc(3, null, null, null, 99);  // about -10%
    const r = semivarianceBalance(bars, day(3), 2);
    expect(r).toMatchObject({ status: "computed", n_positive: 1, n_negative: 1, n_zero: 0 });
  });

  it("returns a null share when there are no returns on either side", () => {
    const bars = [1, 2, 3].map((i) => ohlc(i, null, null, null, 100));
    expect(semivarianceBalance(bars, day(3), 2)).toMatchObject({ status: "computed", positive_share: null, n_zero: 2 });
  });
});

describe("S26-057 gapSessionComponents", () => {
  it("reports gap, open-to-close, and range as separate components and blocks the gap on a missing open", () => {
    const bars = [
      ohlc(1, 100, 101, 99, 100),
      ohlc(2, 102, 104, 101, 103), // gap of +2% from 100
      ohlc(3, null, 104, 102, 103), // missing open
    ];
    const r = gapSessionComponents(bars, day(3), 2);
    expect(r).toMatchObject({ status: "computed", missing_open: 1 });
    if (r.status !== "computed") throw new Error("unexpected");
    expect(r.median_abs_gap_pct).toBeCloseTo(2, 5);
  });

  it("counts a split-like open instead of reading it as a gap", () => {
    const bars = [ohlc(1, 100, 101, 99, 100), ohlc(2, 40, 42, 39, 41), ohlc(3, 41, 42, 40, 41)];
    expect(gapSessionComponents(bars, day(3), 2)).toMatchObject({ status: "computed", split_like: 1 });
  });
});

describe("S26-058 rangeWithoutCloseProgress", () => {
  it("flags widening ranges with a sideways close", () => {
    // Ranges widen in the second half while closes oscillate: net +1% over a path of about 7%.
    const bars = [
      ohlc(1, null, 101, 99, 100),
      ohlc(2, null, 103, 100, 102),
      ohlc(3, null, 106, 95, 99),
      ohlc(4, null, 106, 94, 101),
    ];
    const r = rangeWithoutCloseProgress(bars, day(4), 4);
    expect(r).toMatchObject({ status: "computed", flagged: true });
    if (r.status !== "computed" || r.path_efficiency === null) throw new Error("unexpected");
    expect(r.path_efficiency).toBeLessThanOrEqual(1);
  });

  it("does not flag a steady trend even when ranges widen", () => {
    const bars = [
      ohlc(1, null, 101, 99, 100),
      ohlc(2, null, 102, 99, 102),
      ohlc(3, null, 106, 103, 106),
      ohlc(4, null, 111, 107, 111),
    ];
    const r = rangeWithoutCloseProgress(bars, day(4), 4);
    expect(r).toMatchObject({ status: "computed", flagged: false });
  });

  it("is unsupported when a high or low is missing in the window", () => {
    const bars = [ohlc(1, null, 101, 99, 100), ohlc(2, null, null, 99, 100), ohlc(3, null, 101, 99, 100), ohlc(4, null, 101, 99, 100)];
    expect(rangeWithoutCloseProgress(bars, day(4), 4)).toMatchObject({ status: "unsupported" });
  });
});

describe("S26-061 breakdownDistance", () => {
  it("reports distance to support in both ATR and percent units", () => {
    const bars = [1, 2, 3, 4, 5].map((i) => ohlc(i, null, 101, 99, 100));
    const r = breakdownDistance(bars, day(5), 95, 3);
    expect(r).toMatchObject({ status: "computed", atr: 2, undefined_reason: null });
    if (r.status !== "computed" || r.distance_atr === null) throw new Error("unexpected");
    expect(r.distance_atr).toBeCloseTo(2.5, 5);
    expect(r.distance_pct).toBeCloseTo(5, 5);
  });

  it("gives an explicit undefined state for zero ATR rather than an infinite distance", () => {
    const bars = [1, 2, 3, 4].map((i) => ohlc(i, null, 100, 100, 100));
    expect(breakdownDistance(bars, day(4), 95, 2)).toMatchObject({ status: "computed", distance_atr: null, undefined_reason: "zero ATR" });
  });

  it("rejects a non-positive support level", () => {
    const bars = [1, 2, 3].map((i) => ohlc(i, null, 101, 99, 100));
    expect(() => breakdownDistance(bars, day(3), 0, 2)).toThrow(RangeError);
  });
});

describe("S26-065 newHighLowBalance", () => {
  it("counts a new high, a tie, and a short-history member separately", () => {
    const r = newHighLowBalance(
      [
        { ticker: "AAA", closes: [1, 2, 3, 4, 5] }, // new high
        { ticker: "BBB", closes: [1, 5, 2, 5, 5] }, // last close ties the earlier 5 at the high
        { ticker: "CCC", closes: [1, 2] },          // short history
      ],
      5,
    );
    expect(r).toMatchObject({ eligible: 2, new_highs: 1, ties_high: 1, short_history: 1 });
  });

  it("counts a member with a missing close in the lookback as short history, not as an extreme", () => {
    const r = newHighLowBalance([{ ticker: "DDD", closes: [1, null, 3, 4, 5] }], 5);
    expect(r).toMatchObject({ eligible: 0, short_history: 1 });
  });
});
