import { describe, expect, it } from "vitest";
import { priceImpactRegimeShift, type ImpactBar } from "@/lib/shared/se1/price-impact-proxy";

/** S26-047 fixtures. Pure bars, no feed. The unit and split band are provisional and labeled as such in the module. */
const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
const bar = (i: number, close: number | null, volume: number | null): ImpactBar => ({ date: day(i), close, volume });

/** Builds 2 * window + 1 bars. Each daily move is `step` (a fraction), at `volume` shares a session. */
function series(window: number, steps: number[], volume: number, startClose = 100): ImpactBar[] {
  const bars: ImpactBar[] = [];
  let close = startClose;
  bars.push(bar(1, close, volume));
  for (let i = 0; i < steps.length; i++) {
    close = close * (1 + steps[i]);
    bars.push(bar(i + 2, close, volume));
  }
  return bars;
}

describe("S26-047 priceImpactRegimeShift", () => {
  it("reports a shift above 1 when the recent window moves more per dollar of volume than the prior one", () => {
    // Prior window: 1% daily moves on $1M a session. Recent window: 3% moves on the same $1M.
    const prior = Array(5).fill(0.01);
    const recent = Array(5).fill(0.03);
    const bars = series(5, [...prior, ...recent], 10_000); // close 100 * 10,000 shares = $1M a session
    const r = priceImpactRegimeShift(bars, { cutoff: day(bars.length), window: 5, floorUsd: 100_000 });
    expect(r).toMatchObject({ status: "computed", excluded_split_like: 0, excluded_tiny: 0 });
    if (r.status !== "computed") throw new Error("unreachable");
    // Price drifts up while share volume stays fixed, so dollar volume rises and the per-unit proxy shrinks a little.
    // The ratio stays well above 2 and below 3.5; it is not exactly 3.
    expect(r.shift_ratio).toBeGreaterThan(2);
    expect(r.shift_ratio).toBeLessThan(3.5);
  });

  it("is unsupported when every session is below the dollar-volume floor", () => {
    const steps = Array(10).fill(0.01);
    const bars = series(5, steps, 100); // $10k a session, below a $100k floor everywhere
    const r = priceImpactRegimeShift(bars, { cutoff: day(bars.length), window: 5, floorUsd: 100_000 });
    expect(r).toMatchObject({ status: "unsupported" });
  });

  it("treats a close ratio outside the split band as a possible split, not a price move", () => {
    // Window 8 so that two excluded sessions still leave the 5 usable sessions each window needs.
    const bars = series(8, Array(16).fill(0.01), 10_000);
    // A 2-for-1 style drop on one session: the ratio is well outside the band.
    bars[3] = bar(4, bars[2].close! * 0.5, 10_000);
    const r = priceImpactRegimeShift(bars, { cutoff: day(bars.length), window: 8, floorUsd: 100_000 });
    // The split day (ratio 0.5) and the rebound after it (ratio ~2.04) are both outside the band.
    expect(r).toMatchObject({ status: "computed", excluded_split_like: 2 });
  });

  it("excludes an exact 2-for-1 split at the band edge, with no rebound to mask it", () => {
    // Close steps from 100 to 50 on day 4 and stays there, so that one day's ratio is exactly 0.5.
    const bars = Array.from({ length: 13 }, (_, i) => bar(i + 1, i < 3 ? 100 : 50, 10_000));
    const r = priceImpactRegimeShift(bars, { cutoff: day(bars.length), window: 6, floorUsd: 100_000 });
    expect(r).toMatchObject({ status: "computed", excluded_split_like: 1 });
  });

  it("counts a missing volume as missing, never as a zero move", () => {
    // A missing volume on one session removes only that session's proxy; the window keeps 5 usable.
    const bars = series(6, Array(12).fill(0.01), 10_000);
    bars[11] = bar(12, bars[11].close, null);
    const r = priceImpactRegimeShift(bars, { cutoff: day(bars.length), window: 6, floorUsd: 100_000 });
    expect(r).toMatchObject({ status: "computed", excluded_missing: 1 });
  });

  it("never reads bars after the cutoff", () => {
    const steps = [...Array(5).fill(0.01), ...Array(5).fill(0.01)];
    const base = series(5, steps, 10_000);
    const withFuture = [...base, bar(base.length + 1, base[base.length - 1].close! * 2, 10_000_000)];
    const cut = day(base.length);
    const a = priceImpactRegimeShift(base, { cutoff: cut, window: 5, floorUsd: 100_000 });
    const b = priceImpactRegimeShift(withFuture, { cutoff: cut, window: 5, floorUsd: 100_000 });
    expect(b).toEqual({ ...a, excluded_after_cutoff: 1 });
  });

  it("is unsupported when either window has fewer usable sessions than the minimum", () => {
    const bars = series(5, [0.01, 0.01, 0.01], 10_000);
    expect(priceImpactRegimeShift(bars, { cutoff: day(bars.length), window: 5, floorUsd: 100_000 })).toMatchObject({ status: "unsupported" });
  });

  it("rejects a window below the minimum session count", () => {
    const bars = series(5, Array(10).fill(0.01), 10_000);
    expect(() => priceImpactRegimeShift(bars, { cutoff: day(bars.length), window: 3, floorUsd: 1 })).toThrow(RangeError);
  });
});


describe("cutoff validation", () => {
  it("ignores invalid OHLC values strictly after the cutoff", () => {
    const bars = series(5, Array(10).fill(0.01), 10_000);
    bars.push({ date: "2026-11-01", close: Infinity, volume: Infinity });
    expect(priceImpactRegimeShift(bars, { cutoff: day(bars.length - 1), window: 5, floorUsd: 1 }))
      .toMatchObject({ status: "computed", excluded_after_cutoff: 1 });
  });
});
