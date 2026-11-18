import { describe, expect, it } from "vitest";
import { dollarVolumeFloorPersistence, type VolumeBar } from "@/lib/shared/se1/volume-floor";

/** S26-43: dollar-volume floor persistence. Pure fixtures, no feed, no model. */
const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
const bar = (i: number, close: number | null, volume: number | null): VolumeBar =>
  ({ date: day(i), close, volume });

describe("S26-43 dollarVolumeFloorPersistence", () => {
  it("one huge print cannot hide routinely thin trading", () => {
    // Nine thin sessions at $100k and one $1bn print. A mean would look fine; breach count must not.
    const bars = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => bar(i, 10, 10_000));
    bars.push(bar(10, 10, 100_000_000));
    const r = dollarVolumeFloorPersistence(bars, { cutoff: day(10), window: 10, floorUsd: 1_000_000 });
    expect(r).toMatchObject({ status: "computed", eligible: 10, computed: 10, breach_count: 9, median_usd: 100_000 });
  });

  it("keeps an absent volume distinct from a verified zero, and both from positive low volume", () => {
    const bars = [
      bar(1, 10, null),      // absent: missing, not a breach
      bar(2, 10, 0),         // verified zero: breach and counted as zero_volume
      bar(3, 10, 5_000),     // positive but low: breach, not zero_volume
      bar(4, 10, 500_000),   // above the floor
    ];
    const r = dollarVolumeFloorPersistence(bars, { cutoff: day(4), window: 4, floorUsd: 1_000_000 });
    expect(r).toMatchObject({ status: "computed", eligible: 4, computed: 3, missing: 1, zero_volume: 1, breach_count: 2 });
  });

  it("ignores bars after the decision cutoff and reports how many it excluded", () => {
    const base = [1, 2, 3, 4].map((i) => bar(i, 10, 200_000));
    const withFuture = [...base, bar(5, 10, 9_000_000_000), bar(6, 10, 9_000_000_000)];
    const cut = { cutoff: day(4), window: 4, floorUsd: 1_000_000 };
    const a = dollarVolumeFloorPersistence(base, cut);
    const b = dollarVolumeFloorPersistence(withFuture, cut);
    expect(b).toEqual({ ...a, excluded_after_cutoff: 2 });
  });

  it("is unsupported when history is shorter than the window", () => {
    const r = dollarVolumeFloorPersistence([bar(1, 10, 1e6)], { cutoff: day(1), window: 5, floorUsd: 1 });
    expect(r).toMatchObject({ status: "unsupported" });
  });

  it("rejects invalid options and invalid bars instead of guessing", () => {
    const ok = [bar(1, 10, 1e6), bar(2, 10, 1e6)];
    expect(() => dollarVolumeFloorPersistence(ok, { cutoff: day(2), window: 0, floorUsd: 1 })).toThrow(RangeError);
    expect(() => dollarVolumeFloorPersistence(ok, { cutoff: day(2), window: 2, floorUsd: 0 })).toThrow(RangeError);
    expect(() => dollarVolumeFloorPersistence([bar(1, 10, -5)], { cutoff: day(1), window: 1, floorUsd: 1 })).toThrow(RangeError);
    expect(() => dollarVolumeFloorPersistence([{ date: "2026/10/01", close: 10, volume: 1 }], { cutoff: day(1), window: 1, floorUsd: 1 })).toThrow(RangeError);
  });
});


describe("cutoff validation", () => {
  it("ignores invalid values strictly after the cutoff", () => {
    const bars = [1, 2, 3, 4, 5].map((i) => bar(i, 10, 100));
    bars.push({ date: "2026-11-01", close: Infinity, volume: Infinity });
    expect(dollarVolumeFloorPersistence(bars, { cutoff: day(5), window: 5, floorUsd: 1 }))
      .toMatchObject({ status: "computed", excluded_after_cutoff: 1 });
  });
});
