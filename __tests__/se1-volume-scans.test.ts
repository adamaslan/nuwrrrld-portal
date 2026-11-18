import { describe, expect, it } from "vitest";
import {
  breakoutParticipation, candidateCapacity, confirmationLag, quietPullbackContrast, type VolumeBar,
} from "@/lib/shared/se1/volume-scans";

/** S26-044, 048, 050, 051 fixtures. Pure bars, no feed. Each case names the contract it checks. */
const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
const bar = (i: number, close: number | null, volume: number | null): VolumeBar => ({ date: day(i), close, volume });

describe("S26-044 breakoutParticipation", () => {
  it("reports a breakout as pending, not held, when its hold window is not yet observed by the cutoff", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, 300)); // breakout on the last observed bar
    const r = breakoutParticipation(bars, { cutoff: day(5), baselineWindow: 4, holdWindow: 2 });
    expect(r).toMatchObject({ status: "computed", events: [{ state: "pending", observed_after: 0, relative_volume: 3 }] });
  });

  it("marks a later close back under the level as failed, and keeps the breakout date fixed", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, 300), bar(6, 9, 100), bar(7, 13, 100));
    const r = breakoutParticipation(bars, { cutoff: day(7), baselineWindow: 4, holdWindow: 2 });
    // Two breakouts: day 5 fails on day 6, and day 7 is a new breakout with no hold window observed yet.
    expect(r).toMatchObject({ status: "computed", events: [{ breakout_date: day(5), state: "failed" }, { breakout_date: day(7), state: "pending" }] });
  });

  it("never reads a hold state from bars after the cutoff", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, 300), bar(6, 12.5, 100), bar(7, 12.5, 100));
    const r = breakoutParticipation(bars, { cutoff: day(5), baselineWindow: 4, holdWindow: 2 });
    expect(r).toMatchObject({ status: "computed", events: [{ state: "pending" }] });
  });

  it("returns a null relative volume when the breakout session has no volume", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, null));
    const r = breakoutParticipation(bars, { cutoff: day(5), baselineWindow: 4, holdWindow: 1 });
    expect(r).toMatchObject({ status: "computed", events: [{ relative_volume: null }] });
  });
});

describe("S26-048 quietPullbackContrast", () => {
  const trend = (n: number) => Array.from({ length: n }, (_, i) => bar(i + 1, 100 + i, 1_000_000));

  it("names a liquid pullback on reduced volume with the trend intact as quiet", () => {
    const bars = trend(9);
    // Pullback on very light volume: 105 is about 2.8% under the 108 peak and above the window average of ~104.4.
    bars.push(bar(10, 105, 100_000));
    const r = quietPullbackContrast(bars, { cutoff: day(10), window: 9, floorUsd: 1_000_000, minPullback: 0.02, reducedVolume: 0.5 });
    expect(r).toMatchObject({ status: "computed", classification: "quiet_pullback", liquid: true });
  });

  it("classifies a thin name as illiquid no matter how quiet its volume looks", () => {
    const bars = trend(9).map((b) => ({ ...b, volume: 100 }));
    bars.push(bar(10, 96, 10));
    const r = quietPullbackContrast(bars, { cutoff: day(10), window: 9, floorUsd: 1_000_000, minPullback: 0.03, reducedVolume: 0.5 });
    expect(r).toMatchObject({ status: "computed", classification: "illiquid", liquid: false });
  });

  it("is unsupported when there is not enough history for the window", () => {
    expect(quietPullbackContrast([bar(1, 10, 100)], { cutoff: day(1), window: 9, floorUsd: 1, minPullback: 0.03, reducedVolume: 0.5 }))
      .toMatchObject({ status: "unsupported" });
  });
});

describe("S26-050 confirmationLag", () => {
  it("records a censored pending break when the confirmation window is still open", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, 100));
    const r = confirmationLag(bars, { cutoff: day(5), breakWindow: 4, confirmWindow: 3, confirmMultiple: 2 });
    expect(r).toMatchObject({ status: "computed", records: [{ status: "pending", censored: true }] });
  });

  it("confirms on the first qualifying session and reports the lag, never backdating it", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, 100), bar(6, 12, 100), bar(7, 12, 500));
    const r = confirmationLag(bars, { cutoff: day(7), breakWindow: 4, confirmWindow: 3, confirmMultiple: 2 });
    expect(r).toMatchObject({ status: "computed", records: [{ status: "confirmed", confirm_date: day(7), lag_bars: 2 }] });
  });

  it("marks a fully observed window without confirmation as unconfirmed, not pending", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, 100), bar(6, 12, 100), bar(7, 12, 100), bar(8, 12, 100));
    const r = confirmationLag(bars, { cutoff: day(8), breakWindow: 4, confirmWindow: 3, confirmMultiple: 2 });
    expect(r).toMatchObject({ status: "computed", records: [{ status: "unconfirmed" }] });
  });
});

describe("S26-051 candidateCapacity", () => {
  const liquid = [1, 2, 3, 4, 5].map((i) => bar(i, 10, 100_000)); // $1M per session

  it("reports an unknown notional as missing, never as zero", () => {
    expect(candidateCapacity(liquid, { cutoff: day(5), window: 5, notionalUsd: null, fractions: [0.1] }))
      .toMatchObject({ status: "missing" });
  });

  it("scales the notional against declared fractions of trailing dollar volume", () => {
    const r = candidateCapacity(liquid, { cutoff: day(5), window: 5, notionalUsd: 100_000, fractions: [0.1, 0.5] });
    expect(r).toMatchObject({ status: "computed", trailing_median_dollar_volume: 1_000_000 });
    if (r.status !== "computed") throw new Error("unreachable");
    expect(r.ratios.map((x) => x.ratio)).toEqual([1, 0.2]);
    // A notional exactly equal to a fraction of volume counts as within; here both fractions are within.
    expect(r.ratios.map((x) => x.within)).toEqual([true, true]);
  });

  it("keeps the daily-only limits in its labels", () => {
    const r = candidateCapacity(liquid, { cutoff: day(5), window: 5, notionalUsd: 1, fractions: [0.1] });
    if (r.status !== "computed") throw new Error("unreachable");
    expect(r.labels.join(" ")).toContain("no intraday fill quality");
  });
});


describe("review regressions: missing and post-cutoff observations", () => {
  it("does not call a full breakout hold window held when a close is missing", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    bars.push(bar(5, 12, 300), bar(6, null, 100), bar(7, 13, 100));
    const r = breakoutParticipation(bars, { cutoff: day(7), baselineWindow: 4, holdWindow: 2 });
    expect(r).toMatchObject({ status: "computed", events: [{ state: "unavailable", observed_after: 2 }] });
  });

  it("does not call a fully observed confirmation window unconfirmed when volume is missing", () => {
    const bars = [bar(1, 10, 100), bar(2, 10, 100), bar(3, 11, 300), bar(4, 12, null), bar(5, 12, null)];
    const r = confirmationLag(bars, { cutoff: day(5), breakWindow: 2, confirmWindow: 2, confirmMultiple: 2 });
    expect(r).toMatchObject({ status: "computed", records: [{ status: "unavailable", lag_bars: null }] });
  });

  it("accepts exactly the declared quiet-pullback window length", () => {
    const bars = [bar(1, 10, 100), bar(2, 10, 100), bar(3, 10, 100), bar(4, 10, 100), bar(5, 9, 50)];
    expect(quietPullbackContrast(bars, {
      cutoff: day(5), window: 5, floorUsd: 1, minPullback: 0.05, reducedVolume: 0.6,
    })).toMatchObject({ status: "computed", classification: "abandonment_candidate" });
  });

  it("ignores invalid OHLC values strictly after the cutoff", () => {
    const bars = [1, 2, 3, 4, 5].map((i) => bar(i, i <= 4 ? 10 : 12, 100));
    bars.push({ date: "2026-11-01", close: Infinity, volume: Infinity });
    expect(() => breakoutParticipation(bars, { cutoff: day(5), baselineWindow: 4, holdWindow: 2 })).not.toThrow();
  });
});
