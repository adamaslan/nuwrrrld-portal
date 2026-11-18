import { describe, it, expect } from "vitest";
import { postCapitulationStabilization, gapDownRepairLadder, type Bar } from "@/lib/shared/se1/bottom-scans";

const bar = (date: string, o: number | null, h: number | null, l: number | null, c: number | null, v: number | null = 100): Bar =>
  ({ date, open: o, high: h, low: l, close: c, volume: v });

const capBase = (): Bar[] => [
  bar("2026-01-01", 100, 101, 99, 100),
  bar("2026-01-02", 100, 101, 99, 100),
  bar("2026-01-03", 100, 101, 99, 100),
  bar("2026-01-04", 100, 101, 99, 100),
  bar("2026-01-05", 100, 101, 99, 100),
  bar("2026-01-06", 90, 91, 89, 90, 1000),
];
const capOpts = { cutoff: "2026-01-08", volumeWindow: 5, minDrop: 0.05, volumeMultiple: 2, quietWindow: 2 };

describe("review A: postCapitulationStabilization with missing quiet-period closes", () => {
  it("two missing closes cannot establish a quiet period", () => {
    const bars = [...capBase(), bar("2026-01-07", null, null, null, null), bar("2026-01-08", null, null, null, null)];
    const r = postCapitulationStabilization(bars, capOpts);
    if (r.status !== "computed") throw new Error("expected computed");
    expect(r.events).toHaveLength(1);
    const e = r.events[0];
    expect(e.event_date).toBe("2026-01-06");
    expect(e.state).not.toBe("stabilized");
    expect(["pending", "unavailable"]).toContain(e.state);
    expect(e.stabilization_bars).toBeNull();
    expect(e.unresolved_low).toBe(90);
  });

  it("one missing close inside the window is still not a quiet period (horizon not extended)", () => {
    const bars = [...capBase(), bar("2026-01-07", 91, 92, 90, 91), bar("2026-01-08", null, null, null, null),
      bar("2026-01-09", 92, 93, 91, 92)];
    const r = postCapitulationStabilization(bars, { ...capOpts, cutoff: "2026-01-09" });
    if (r.status !== "computed") throw new Error("expected computed");
    expect(r.events[0].state).not.toBe("stabilized");
    expect(r.events[0].stabilization_bars).toBeNull();
  });

  it("an observed close below the event close still cancels despite a missing close", () => {
    const bars = [...capBase(), bar("2026-01-07", null, null, null, null), bar("2026-01-08", 86, 87, 84, 85)];
    const r = postCapitulationStabilization(bars, capOpts);
    if (r.status !== "computed") throw new Error("expected computed");
    expect(r.events[0].state).toBe("cancelled");
  });

  it("a fully observed quiet window still stabilizes", () => {
    const bars = [...capBase(), bar("2026-01-07", 91, 92, 90, 91), bar("2026-01-08", 92, 93, 91, 92)];
    const r = postCapitulationStabilization(bars, capOpts);
    if (r.status !== "computed") throw new Error("expected computed");
    expect(r.events[0].state).toBe("stabilized");
    expect(r.events[0].stabilization_bars).toBe(2);
  });

  it("patched contract: elapsed window with missing closes is explicitly 'unavailable'", () => {
    const bars = [...capBase(), bar("2026-01-07", null, null, null, null), bar("2026-01-08", null, null, null, null)];
    const r = postCapitulationStabilization(bars, capOpts);
    if (r.status !== "computed") throw new Error("expected computed");
    expect(r.events[0].state).toBe("unavailable");
  });

  it("an unelapsed window is pending", () => {
    const bars = [...capBase(), bar("2026-01-07", 91, 92, 90, 91)];
    const r = postCapitulationStabilization(bars, { ...capOpts, cutoff: "2026-01-07" });
    if (r.status !== "computed") throw new Error("expected computed");
    expect(r.events[0].state).toBe("pending");
  });
});

describe("review B: gapDownRepairLadder gives no recovery credit after invalidation", () => {
  it("invalidated gap earns no later recovery or milestones", () => {
    const bars = [
      bar("2026-01-01", 100, 101, 99, 100),
      bar("2026-01-02", 90, 92, 89, 90),
      bar("2026-01-03", 86, 87, 84, 85),
      bar("2026-01-04", 100, 102, 99, 101),
    ];
    const r = gapDownRepairLadder(bars, { cutoff: "2026-01-04", minGap: 0.05 });
    if (r.status !== "computed") throw new Error("expected computed");
    const g = r.gaps.find((x) => x.gap_date === "2026-01-02")!;
    expect(g.invalidated).toBe(true);
    expect(g.invalidation_date).toBe("2026-01-03");
    expect(g.recovered_fraction).toBe(0);
    expect(g.milestones.every((m) => m.date === null)).toBe(true);
  });

  it("keeps milestones reached before invalidation", () => {
    const bars = [
      bar("2026-01-01", 100, 101, 99, 100),
      bar("2026-01-02", 90, 92, 89, 90),
      bar("2026-01-03", 91, 94, 90, 93), // 30% repaired
      bar("2026-01-04", 90, 91, 88, 89), // low 88 < 89 invalidates
      bar("2026-01-05", 99, 102, 98, 101),
    ];
    const r = gapDownRepairLadder(bars, { cutoff: "2026-01-05", minGap: 0.05 });
    if (r.status !== "computed") throw new Error("expected computed");
    const g = r.gaps.find((x) => x.gap_date === "2026-01-02")!;
    expect(g.invalidation_date).toBe("2026-01-04");
    expect(g.recovered_fraction).toBeCloseTo(0.3, 10);
    expect(g.milestones).toEqual([
      { fraction: 0.25, date: "2026-01-03" },
      { fraction: 0.5, date: null },
      { fraction: 0.75, date: null },
      { fraction: 1, date: null },
    ]);
  });

  it("same-session rule: a session whose low invalidates earns no repair credit at its close", () => {
    // Daily bars cannot show intraday order. Conservative rule: invalidation on a session takes precedence;
    // that session's close earns no repair credit. (The close is the session's last print, so the low cannot
    // come after it; crediting the close would credit a repair of an already-invalidated gap.)
    const bars = [
      bar("2026-01-01", 100, 101, 99, 100),
      bar("2026-01-02", 90, 92, 89, 90),
      bar("2026-01-03", 88, 101, 85, 100), // low 85 invalidates; close 100 would be full repair
    ];
    const r = gapDownRepairLadder(bars, { cutoff: "2026-01-03", minGap: 0.05 });
    if (r.status !== "computed") throw new Error("expected computed");
    const g = r.gaps.find((x) => x.gap_date === "2026-01-02")!;
    expect(g.invalidation_date).toBe("2026-01-03");
    expect(g.recovered_fraction).toBe(0);
    expect(g.milestones.every((m) => m.date === null)).toBe(true);
  });

  it("un-invalidated gap still reaches full repair", () => {
    const bars = [
      bar("2026-01-01", 100, 101, 99, 100),
      bar("2026-01-02", 90, 92, 89, 90),
      bar("2026-01-03", 95, 101, 94, 101),
    ];
    const r = gapDownRepairLadder(bars, { cutoff: "2026-01-03", minGap: 0.05 });
    if (r.status !== "computed") throw new Error("expected computed");
    const g = r.gaps[0];
    expect(g.invalidated).toBe(false);
    expect(g.recovered_fraction).toBe(1);
    expect(g.milestones.every((m) => m.date === "2026-01-03")).toBe(true);
  });
});
