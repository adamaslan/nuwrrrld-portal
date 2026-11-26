import { describe, expect, it } from "vitest";
import { participationAsymmetry, volumeConcentration, type ParticipationBar } from "@/lib/shared/se1/volume-participation";

/** S26-45 and S26-46 fixtures. Pure bars, no feed. Each case names the contract it checks. */
const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
const bar = (i: number, close: number | null, volume: number | null): ParticipationBar => ({ date: day(i), close, volume });

describe("S26-45 volumeConcentration", () => {
  it("one event spike is reported as dominant and excluded from the baseline, not narrated as persistence", () => {
    const bars = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => bar(i, 10, 1_000));
    bars.push(bar(10, 10, 500_000));
    const r = volumeConcentration(bars, { cutoff: day(10), window: 10 }, 1);
    expect(r).toMatchObject({ status: "computed", spike_dominated: true, events_excluded: 1, baseline_remaining: 9 });
  });

  it("evenly spread volume is not dominated", () => {
    const bars = [1, 2, 3, 4, 5, 6].map((i) => bar(i, 10, 1_000));
    const r = volumeConcentration(bars, { cutoff: day(6), window: 6 }, 3);
    expect(r).toMatchObject({ status: "computed", spike_dominated: false, events_excluded: 0 });
  });

  it("bars after the cutoff never enter the window", () => {
    const base = [1, 2, 3, 4, 5, 6].map((i) => bar(i, 10, 1_000));
    const withFuture = [...base, bar(7, 10, 900_000_000)];
    const a = volumeConcentration(base, { cutoff: day(6), window: 6 }, 1);
    const b = volumeConcentration(withFuture, { cutoff: day(6), window: 6 }, 1);
    expect(b).toEqual({ ...a, excluded_after_cutoff: 1 });
  });

  it("a window with no volume is unsupported, not zero concentration", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 0));
    expect(volumeConcentration(bars, { cutoff: day(4), window: 4 }, 2)).toMatchObject({ status: "unsupported" });
  });

  it("rejects an invalid top-k", () => {
    const bars = [1, 2, 3, 4].map((i) => bar(i, 10, 100));
    expect(() => volumeConcentration(bars, { cutoff: day(4), window: 4 }, 0)).toThrow(RangeError);
  });
});

describe("S26-46 participationAsymmetry", () => {
  it("separates up, down, and flat volume without assigning flat sessions to a side", () => {
    const bars = [
      bar(1, 10, 100),
      bar(2, 11, 200), // up
      bar(3, 11, 300), // flat
      bar(4, 10, 400), // down
    ];
    const r = participationAsymmetry(bars, { cutoff: day(4), window: 3 });
    expect(r).toMatchObject({ status: "computed", up_volume: 200, down_volume: 400, flat_volume: 300, flat_days: 1, up_share: 200 / 600 });
  });

  it("returns a null share instead of dividing by zero when no session moved", () => {
    const bars = [bar(1, 10, 100), bar(2, 10, 100), bar(3, 10, 100)];
    const r = participationAsymmetry(bars, { cutoff: day(3), window: 2 });
    expect(r).toMatchObject({ status: "computed", up_share: null, flat_days: 2 });
  });

  it("counts a missing close as a missing day, and the next session too, since it has no prior close", () => {
    // Day 2 has no close, so day 3 cannot be compared with day 2 either. Both are missing; neither is a side.
    const bars = [bar(1, 10, 100), bar(2, null, 200), bar(3, 12, 300)];
    const r = participationAsymmetry(bars, { cutoff: day(3), window: 2 });
    expect(r).toMatchObject({ status: "computed", missing_days: 2, up_volume: 0, down_volume: 0, up_share: null });
  });

  it("is unsupported without the extra prior bar needed for the first session", () => {
    const bars = [bar(1, 10, 100), bar(2, 11, 100)];
    expect(participationAsymmetry(bars, { cutoff: day(2), window: 2 })).toMatchObject({ status: "unsupported" });
  });
});


describe("cutoff validation", () => {
  it("ignores invalid values strictly after the cutoff for both participation scans", () => {
    const bars = [1, 2, 3, 4, 5, 6].map((i) => bar(i, 10 + i, 100));
    bars.push({ date: "2026-11-01", close: Infinity, volume: Infinity });
    expect(volumeConcentration(bars, { cutoff: day(6), window: 6 }, 1))
      .toMatchObject({ status: "computed", excluded_after_cutoff: 1 });
    expect(participationAsymmetry(bars, { cutoff: day(6), window: 5 }))
      .toMatchObject({ status: "computed", excluded_after_cutoff: 1 });
  });
});
