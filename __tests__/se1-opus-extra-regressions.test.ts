import { describe, expect, it } from "vitest";
import { failedBreakdownReclaim, secondLowContraction, type Bar } from "@/lib/shared/se1/bottom-scans";
import { breakdownDistance, gapSessionComponents, rangeWithoutCloseProgress, semivarianceBalance, newHighLowBalance, type OhlcBar } from "@/lib/shared/se1/trend-vol-scans";

/** Regressions for the five defects the independent Opus review reported beyond PR409/PR410's reproduced cases. */
const day = (i: number) => `2026-02-${String(i).padStart(2, "0")}`;
const bar = (i: number, close: number | null): Bar =>
  ({ date: day(i), open: close, high: close === null ? null : close + 1, low: close === null ? null : close - 1, close, volume: 100 });
const ohlc = (i: number, o: number | null, h: number | null, l: number | null, c: number | null): OhlcBar => ({ date: day(i), open: o, high: h, low: l, close: c });

describe("failedBreakdownReclaim with missing closes", () => {
  // Five flat closes set support at 100, then a breach to 90.
  const base = [1, 2, 3, 4, 5].map((i) => bar(i, 100));
  const opts = { supportWindow: 5, reclaimWindow: 2, atrWindow: 3 };

  it("is unavailable, not continuing_breakdown, when the elapsed window has a missing close", () => {
    const bars = [...base, bar(6, 90), bar(7, null), bar(8, 91)];
    const r = failedBreakdownReclaim(bars, { cutoff: day(8), ...opts });
    expect(r).toMatchObject({ status: "computed", events: [{ state: "unavailable" }] });
  });

  it("stays pending while the window is still open, even with a missing close", () => {
    const bars = [...base, bar(6, 90), bar(7, null)];
    const r = failedBreakdownReclaim(bars, { cutoff: day(7), ...opts });
    expect(r).toMatchObject({ status: "computed", events: [{ state: "pending" }] });
  });

  it("still reports a reclaim and a true continuing breakdown when closes are all present", () => {
    const reclaimed = failedBreakdownReclaim([...base, bar(6, 90), bar(7, 101), bar(8, 102)], { cutoff: day(8), ...opts });
    const continuing = failedBreakdownReclaim([...base, bar(6, 90), bar(7, 89), bar(8, 88)], { cutoff: day(8), ...opts });
    expect(reclaimed).toMatchObject({ events: [{ state: "reclaimed" }] });
    // In a continuing breakdown each new lower close is its own breach; the first event is the one under test.
    if (continuing.status !== "computed") throw new Error("unexpected");
    expect(continuing.events[0]).toMatchObject({ breach_date: day(6), state: "continuing_breakdown" });
  });
});

describe("rangeWithoutCloseProgress with a zero close", () => {
  it("is unsupported instead of returning infinite or negative values", () => {
    const bars = [ohlc(1, null, 1, 0, 0), ohlc(2, null, 2, 1, 1), ohlc(3, null, 3, 2, 2), ohlc(4, null, 4, 3, 3)];
    expect(rangeWithoutCloseProgress(bars, day(4), 4)).toMatchObject({ status: "unsupported", reason: "zero close in window" });
  });
});

describe("secondLowContraction with missing selling-volume evidence", () => {
  it("does not allow an exhaustion label for a lower low when volume cannot be compared", () => {
    const closes = [105, 104, 90, 100, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 85, 100, 105, 110];
    const bars: Bar[] = closes.map((close, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: null,
    }));
    const r = secondLowContraction(bars, { cutoff: "2026-01-22", pivotK: 1, minSeparation: 10, atrWindow: 3 });
    if (r.status !== "computed") throw new Error("expected computed");
    expect(r.pairs[0]).toMatchObject({ new_lower_low: true, heavier_selling: null, exhaustion_label_allowed: false });
  });
});

describe("breakdownDistance with a zero cutoff close", () => {
  it("does not return infinite percent distance", () => {
    const bars = [ohlc(1, 10, 11, 9, 10), ohlc(2, 9, 10, 8, 9), ohlc(3, 8, 9, 7, 8), ohlc(4, 0, 1, 0, 0)];
    const r = breakdownDistance(bars, day(4), 5, 3);
    expect(r).toMatchObject({ status: "unsupported", reason: "zero close at cutoff" });
  });
});

describe("gapSessionComponents with an empty component", () => {
  it("returns null, not NaN, when no session has a usable open", () => {
    const bars = [ohlc(1, null, 101, 99, 100), ohlc(2, null, 102, 100, 101), ohlc(3, null, 103, 101, 102)];
    const r = gapSessionComponents(bars, day(3), 2);
    if (r.status !== "computed") throw new Error("unexpected");
    expect(r.median_abs_gap_pct).toBeNull();
    expect(r.median_abs_open_to_close_pct).toBeNull();
    expect(Number.isNaN(r.median_range_pct as number)).toBe(false);
  });
});

describe("semivarianceBalance with an unusable prior close", () => {
  it("counts the sessions it skipped instead of dropping them silently", () => {
    const bars = [ohlc(1, null, null, null, 0), ohlc(2, null, null, null, 10), ohlc(3, null, null, null, 11)];
    const r = semivarianceBalance(bars, day(3), 2);
    expect(r).toMatchObject({ status: "computed", skipped_unusable_prior: 1, n_positive: 1 });
  });
});

describe("newHighLowBalance with a missing close in the lookback", () => {
  it("reports it as missing_in_window and keeps short_history for genuinely short series", () => {
    const r = newHighLowBalance(
      [
        { ticker: "AAA", closes: [1, null, 3, 4, 5] },
        { ticker: "BBB", closes: [1, 2] },
      ],
      5,
    );
    expect(r).toMatchObject({ eligible: 0, missing_in_window: 1, short_history: 1 });
  });
});
