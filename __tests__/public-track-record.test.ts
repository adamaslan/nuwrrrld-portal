import { describe, expect, it } from "vitest";
import { buildPublicTrackRecord, type ScoreInput } from "@/lib/public-track-record";
import { MIN_RESOLVED_FOR_RATE } from "@/lib/eval-scoring";

function row(
  horizon: ScoreInput["horizon"],
  outcome: ScoreInput["outcome"],
  directional: number | null,
  resolvedOn = "2026-11-01",
): ScoreInput {
  return { horizon, outcome, directional, resolvedOn };
}

describe("buildPublicTrackRecord", () => {
  it("returns null when nothing is scored", () => {
    expect(buildPublicTrackRecord([])).toBeNull();
  });

  it("counts misses, flats and voids next to hits", () => {
    const rec = buildPublicTrackRecord([
      row("d1", "hit", 2),
      row("d1", "miss", -3),
      row("d1", "flat", 0.1),
      row("d1", "void", null),
    ]);
    const d1 = rec!.horizons[0];
    expect(d1).toMatchObject({ horizon: "d1", hits: 1, misses: 1, flats: 1, voids: 1, decisive: 2 });
    expect(rec!.totalScored).toBe(4);
  });

  it("withholds the rate below the minimum number of decisive calls", () => {
    const rows = Array.from({ length: MIN_RESOLVED_FOR_RATE - 1 }, () => row("w1", "hit", 1));
    expect(buildPublicTrackRecord(rows)!.horizons[0].hitRatePct).toBeNull();
  });

  it("reports the rate at exactly the minimum, with misses in the denominator", () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row("m1", "hit", 2)),
      ...Array.from({ length: 10 }, () => row("m1", "miss", -2)),
    ];
    const m1 = buildPublicTrackRecord(rows)!.horizons[0];
    expect(m1.decisive).toBe(30);
    expect(m1.hitRatePct).toBeCloseTo(66.667, 2);
  });

  it("excludes flats and voids from the denominator", () => {
    const rows = [
      ...Array.from({ length: 30 }, () => row("m3", "hit", 5)),
      ...Array.from({ length: 50 }, () => row("m3", "flat", 0)),
      ...Array.from({ length: 5 }, () => row("m3", "void", null)),
    ];
    const m3 = buildPublicTrackRecord(rows)!.horizons[0];
    expect(m3.decisive).toBe(30);
    expect(m3.hitRatePct).toBe(100);
  });

  it("orders horizons canonically and skips horizons with no rows", () => {
    const rec = buildPublicTrackRecord([row("m1", "hit", 1), row("d1", "miss", -1), row("y1", "hit", 1)]);
    expect(rec!.horizons.map((h) => h.horizon)).toEqual(["d1", "m1", "y1"]);
  });

  it("tracks the latest resolution date across horizons", () => {
    const rec = buildPublicTrackRecord([
      row("d1", "hit", 1, "2026-10-05"),
      row("w1", "hit", 1, "2026-11-09"),
      row("m1", "miss", -1, "2026-10-30"),
    ]);
    expect(rec!.latestResolvedOn).toBe("2026-11-09");
  });

  it("exposes no per-pick identifiers", () => {
    const rec = buildPublicTrackRecord([row("d1", "hit", 1)]);
    expect(JSON.stringify(rec)).not.toMatch(/pick|ticker|price/i);
  });
});
