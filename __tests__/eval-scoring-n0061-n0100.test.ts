import { describe, expect, it } from "vitest";
import {
  aggregate,
  classifyOutcome,
  DEAD_BAND_PCT,
  HORIZONS,
  MIN_RESOLVED_FOR_RATE,
  returnPct,
  scorePick,
  type Outcome,
  type ScoredPick,
} from "@/lib/eval-scoring";

/**
 * NWF next-1000 packet A, scoreboard and return-boundary cases N-0061..N-0100.
 *
 * Each case asserts behavior the pure module already has, against the real
 * exports, with a fixed input and an expected result. Cases that depend on the
 * DB, the caller, the UI, or an unresolved policy (bootstrap CI, multiple-
 * horizon correction, split detection, currency/adjustedness checks) are not
 * asserted here; they are listed in the PR body as not covered.
 */

const scored = (outcome: Outcome, directional = 0): ScoredPick => ({
  outcome,
  returnPct: directional,
  directional,
});

const repeat = (outcome: Outcome, count: number): ScoredPick[] =>
  Array.from({ length: count }, () => scored(outcome, outcome === "hit" ? 3 : -3));

describe("N-0061..N-0066 sample-size honesty", () => {
  it("N-0061: sample count zero yields n=0 and null rate and mean", () => {
    const agg = aggregate([]);
    expect(agg.n).toBe(0);
    expect(agg.hitRatePct).toBeNull();
    expect(agg.meanDirectionalPct).toBeNull();
  });

  it("N-0062: sample count one reports n=1 with no rate", () => {
    const agg = aggregate([scored("hit", 3)]);
    expect(agg.n).toBe(1);
    expect(agg.hitRatePct).toBeNull();
  });

  it("N-0063 / N-0064: 29 suppressed, 30 reported at the threshold", () => {
    expect(MIN_RESOLVED_FOR_RATE).toBe(30);
    expect(aggregate(repeat("hit", 29)).hitRatePct).toBeNull();
    expect(aggregate(repeat("hit", 30)).hitRatePct).toBe(100);
  });

  it("N-0065: all wins on a small sample reports counts, suppresses the rate", () => {
    const agg = aggregate(repeat("hit", 5));
    expect(agg.hits).toBe(5);
    expect(agg.misses).toBe(0);
    expect(agg.hitRatePct).toBeNull();
  });

  it("N-0066: all losses on a small sample reports counts, suppresses the rate", () => {
    const agg = aggregate(repeat("miss", 5));
    expect(agg.misses).toBe(5);
    expect(agg.hits).toBe(0);
    expect(agg.hitRatePct).toBeNull();
  });
});

describe("N-0068..N-0070 excluded picks and tie definition", () => {
  it("N-0068 / N-0069: missing or failed prices score void and are counted", () => {
    const missing = scorePick({
      direction: "bull",
      entryPrice: 100,
      exitPrice: Number.NaN,
      horizon: "d1",
    });
    const failed = scorePick({
      direction: "bull",
      entryPrice: 0,
      exitPrice: 101,
      horizon: "d1",
    });
    expect(missing.outcome).toBe("void");
    expect(failed.outcome).toBe("void");

    const agg = aggregate([missing, failed, scored("hit", 3)]);
    expect(agg.voids).toBe(2);
    expect(agg.n).toBe(1);
  });

  it("N-0070: a move exactly on the band is flat in both directions", () => {
    for (const horizon of HORIZONS) {
      const tau = DEAD_BAND_PCT[horizon];
      expect(classifyOutcome(tau, horizon)).toBe("flat");
      expect(classifyOutcome(-tau, horizon)).toBe("flat");
    }
  });
});

describe("N-0077 / N-0079 / N-0080 ladder, annualization, units", () => {
  it("N-0077: dead-band ladder matches the doc's verbatim values", () => {
    expect(HORIZONS).toEqual(["d1", "w1", "m1", "m3", "m6", "ytd", "y1"]);
    expect(DEAD_BAND_PCT).toEqual({
      d1: 0.5,
      w1: 1,
      m1: 2,
      m3: 3,
      m6: 5,
      ytd: 5,
      y1: 8,
    });
  });

  it("N-0079: a one-year return is the plain period percent, not annualized", () => {
    expect(returnPct(100, 150)).toBeCloseTo(50, 10);
  });

  it("N-0080: hit-rate is expressed in percent, not as a 0..1 fraction", () => {
    expect(aggregate(repeat("hit", 30)).hitRatePct).toBe(100);
    const half = [...repeat("hit", 15), ...repeat("miss", 15)];
    expect(aggregate(half).hitRatePct).toBe(50);
  });
});

describe("N-0081..N-0100 return calculation boundaries", () => {
  it("N-0081: entry price zero is void, not a number", () => {
    expect(
      scorePick({ direction: "bull", entryPrice: 0, exitPrice: 10, horizon: "w1" }).outcome,
    ).toBe("void");
  });

  it("N-0082 / N-0083: missing entry or exit (undefined) is void", () => {
    expect(
      scorePick({
        direction: "bull",
        entryPrice: undefined as unknown as number,
        exitPrice: 10,
        horizon: "w1",
      }).outcome,
    ).toBe("void");
    expect(
      scorePick({
        direction: "bull",
        entryPrice: 10,
        exitPrice: undefined as unknown as number,
        horizon: "w1",
      }).outcome,
    ).toBe("void");
  });

  it("N-0084: entry equals exit is a zero move and flat", () => {
    const s = scorePick({ direction: "bear", entryPrice: 42, exitPrice: 42, horizon: "d1" });
    expect(s.returnPct).toBe(0);
    expect(s.outcome).toBe("flat");
  });

  it("N-0085 / N-0086: a one-cent move on a $100 stock is flat on d1", () => {
    expect(
      scorePick({ direction: "bull", entryPrice: 100, exitPrice: 100.01, horizon: "d1" }).outcome,
    ).toBe("flat");
    expect(
      scorePick({ direction: "bull", entryPrice: 100, exitPrice: 99.99, horizon: "d1" }).outcome,
    ).toBe("flat");
  });

  it("N-0087: a 50% split-like drop is scored as a real move, so the module does not detect splits", () => {
    const bull = scorePick({ direction: "bull", entryPrice: 100, exitPrice: 50, horizon: "y1" });
    const bear = scorePick({ direction: "bear", entryPrice: 100, exitPrice: 50, horizon: "y1" });
    expect(bull.outcome).toBe("miss");
    expect(bear.outcome).toBe("hit");
  });

  it("N-0088: a negative raw exit price is void, never a short win", () => {
    expect(
      scorePick({ direction: "bear", entryPrice: 100, exitPrice: -5, horizon: "d1" }).outcome,
    ).toBe("void");
  });

  it("N-0092: a same-day horizon with no move is flat, not a miss", () => {
    expect(
      scorePick({ direction: "bull", entryPrice: 10, exitPrice: 10, horizon: "d1" }).outcome,
    ).toBe("flat");
  });

  it("N-0099: one tick past the d1 band is a hit; exactly on it is flat", () => {
    // 100 -> 100.5 is exactly +0.5%, which sits on the band edge.
    expect(
      scorePick({ direction: "bull", entryPrice: 100, exitPrice: 100.5, horizon: "d1" }).outcome,
    ).toBe("flat");
    expect(
      scorePick({ direction: "bull", entryPrice: 100, exitPrice: 100.51, horizon: "d1" }).outcome,
    ).toBe("hit");
  });

  it("N-0100: finite positive inputs always give finite numbers and a known outcome", () => {
    const prices = [0.01, 1, 9.99, 100, 2500.5];
    const outcomes: Outcome[] = ["hit", "miss", "flat", "void"];
    for (const entryPrice of prices) {
      for (const exitPrice of prices) {
        for (const direction of ["bull", "bear"] as const) {
          for (const horizon of HORIZONS) {
            const s = scorePick({ direction, entryPrice, exitPrice, horizon });
            expect(Number.isFinite(s.returnPct)).toBe(true);
            expect(Number.isFinite(s.directional)).toBe(true);
            expect(outcomes).toContain(s.outcome);
          }
        }
      }
    }
  });
});
