import { describe, expect, it } from "vitest";

import { validateBarRow } from "@/lib/shared/engine-bars";
import { structureToFibSummary } from "@/lib/shared/engine-ladder";
import { buildFibLadder } from "@/lib/shared/fib-levels";
import golden from "./fixtures/fib-golden.json";
import { buildFrame, snapshotFrame, type Bar } from "@/lib/engine";

function fixtureSnapshotWithLeg() {
  for (const s of (golden as { series: Array<{ ohlcv: number[][] }> }).series) {
    const bars: Bar[] = s.ohlcv.map(([open, high, low, close, volume]) => ({ open, high, low, close, volume }));
    const snap = snapshotFrame(buildFrame(bars));
    if (snap.levels.length > 0) return snap;
  }
  throw new Error("no fixture series has a leg");
}

const good = { ticker: "aapl", barDate: "2026-09-25", open: 10, high: 11, low: 9, close: 10.5, volume: 1000 };

describe("validateBarRow", () => {
  it("normalizes and accepts a good row", () => {
    expect(validateBarRow(good)).toEqual({ ...good, ticker: "AAPL" });
  });

  it.each([
    ["bad ticker", { ...good, ticker: "not a ticker" }],
    ["bad date", { ...good, barDate: "2026-13-40" }],
    ["zero price", { ...good, open: 0 }],
    ["NaN close", { ...good, close: "x" }],
    ["negative volume", { ...good, volume: -1 }],
    ["high below close", { ...good, high: 10 }],
    ["low above open", { ...good, low: 10.2 }],
  ])("rejects %s", (_name, row) => {
    expect(typeof validateBarRow(row)).toBe("string");
  });

  it("rejects non-objects", () => {
    expect(typeof validateBarRow(null)).toBe("string");
  });
});

describe("structureToFibSummary", () => {
  it("renders through buildFibLadder unchanged", () => {
    const snap = fixtureSnapshotWithLeg();
    expect(snap.levels.length).toBe(7);
    const summary = structureToFibSummary({
      levels: JSON.parse(JSON.stringify(snap.levels)),
      zones: JSON.parse(JSON.stringify(snap.zones)),
      nearest_support: snap.nearestSupport,
      nearest_resistance: snap.nearestResistance,
    });
    expect(buildFibLadder(summary)).not.toBeNull();
  });

  it("tolerates malformed jsonb", () => {
    const summary = structureToFibSummary({ levels: null, zones: "x", nearest_support: null, nearest_resistance: null });
    expect(summary.fib_levels).toEqual([]);
    expect(buildFibLadder(summary)).toBeNull();
  });
});
