/**
 * eval-scoring — unit tests for the followed-tickers outcome math.
 *
 * Runs without DATABASE_URL by design: lib/eval-scoring.ts is pure. A scoring
 * bug is invisible (it produces plausible numbers), so these cover every
 * branch of the classification + aggregation + baseline logic.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  classifyOutcome,
  computeBaselines,
  DEAD_BAND_PCT,
  daysHeld,
  directionalReturn,
  MIN_RESOLVED_FOR_RATE,
  returnPct,
  scorePick,
  type BaselineInput,
  type ScoredPick,
} from "@/lib/eval-scoring";

describe("returnPct", () => {
  it("is a plain percent change", () => {
    expect(returnPct(100, 110)).toBeCloseTo(10);
    expect(returnPct(100, 90)).toBeCloseTo(-10);
    expect(returnPct(200, 200)).toBe(0);
  });
  it("guards a non-positive entry price", () => {
    expect(returnPct(0, 100)).toBe(0);
    expect(returnPct(-5, 100)).toBe(0);
  });
});

describe("directionalReturn", () => {
  it("a bull call profits when price rises", () => {
    expect(directionalReturn(100, 110, "bull")).toBeCloseTo(10);
  });
  it("a bear call profits when price falls", () => {
    expect(directionalReturn(100, 90, "bear")).toBeCloseTo(10);
    expect(directionalReturn(100, 110, "bear")).toBeCloseTo(-10);
  });
});

describe("classifyOutcome — dead band scales with horizon", () => {
  it("d1 band is 0.5%", () => {
    expect(classifyOutcome(0.6, "d1")).toBe("hit");
    expect(classifyOutcome(0.4, "d1")).toBe("flat");
    expect(classifyOutcome(-0.6, "d1")).toBe("miss");
  });
  it("y1 band is 8% — a 5% move is still flat", () => {
    expect(classifyOutcome(5, "y1")).toBe("flat");
    expect(classifyOutcome(9, "y1")).toBe("hit");
    expect(classifyOutcome(-9, "y1")).toBe("miss");
  });
  it("exactly on the band edge is flat, not a hit", () => {
    expect(classifyOutcome(DEAD_BAND_PCT.m1, "m1")).toBe("flat");
    expect(classifyOutcome(-DEAD_BAND_PCT.m1, "m1")).toBe("flat");
  });
});

describe("scorePick", () => {
  it("void picks score void with zeroed numbers", () => {
    const s = scorePick({ direction: "bull", entryPrice: 100, exitPrice: 0, horizon: "w1", void: true });
    expect(s).toEqual({ outcome: "void", returnPct: 0, directional: 0 });
  });
  it("a bear pick that fell past the band is a hit", () => {
    const s = scorePick({ direction: "bear", entryPrice: 100, exitPrice: 94, horizon: "w1" });
    expect(s.outcome).toBe("hit");
    expect(s.returnPct).toBeCloseTo(-6);
    expect(s.directional).toBeCloseTo(6);
  });
});

describe("aggregate", () => {
  const mk = (outcome: ScoredPick["outcome"], directional = 0): ScoredPick => ({
    outcome,
    returnPct: directional,
    directional,
  });

  it("suppresses the rate below n=30 but still reports counts", () => {
    const scored = [
      ...Array.from({ length: 10 }, () => mk("hit", 5)),
      ...Array.from({ length: 5 }, () => mk("miss", -5)),
      mk("flat"),
      mk("void"),
    ];
    const agg = aggregate(scored);
    expect(agg.n).toBe(15);
    expect(agg.hits).toBe(10);
    expect(agg.misses).toBe(5);
    expect(agg.flats).toBe(1);
    expect(agg.voids).toBe(1);
    expect(agg.hitRatePct).toBeNull();
    expect(agg.meanDirectionalPct).toBeCloseTo((10 * 5 + 5 * -5) / 15);
  });

  it("reports the rate once n reaches the threshold", () => {
    const scored = [
      ...Array.from({ length: 21 }, () => mk("hit", 3)),
      ...Array.from({ length: 9 }, () => mk("miss", -3)),
    ];
    const agg = aggregate(scored);
    expect(agg.n).toBe(MIN_RESOLVED_FOR_RATE);
    expect(agg.hitRatePct).toBeCloseTo(70);
  });

  it("flats and voids never enter the rate denominator", () => {
    const scored = [
      ...Array.from({ length: 30 }, () => mk("hit", 1)),
      ...Array.from({ length: 100 }, () => mk("flat")),
      ...Array.from({ length: 50 }, () => mk("void")),
    ];
    const agg = aggregate(scored);
    expect(agg.n).toBe(30);
    expect(agg.hitRatePct).toBeCloseTo(100);
  });

  it("empty input yields null rate and null mean", () => {
    const agg = aggregate([]);
    expect(agg.hitRatePct).toBeNull();
    expect(agg.meanDirectionalPct).toBeNull();
  });
});

describe("computeBaselines", () => {
  const rows: BaselineInput[] = Array.from({ length: 40 }, (_, i) => ({
    direction: (i % 2 === 0 ? "bull" : "bear") as "bull" | "bear",
    entryPrice: 100,
    exitPrice: 100 + (i % 2 === 0 ? 5 : 5), // price always rose 5%
    spyEntryPrice: 400,
    spyExitPrice: 408, // SPY rose 2%
    horizon: "w1" as const,
    backtestPrior: 0.6,
  }));

  it("coin flip is always 50", () => {
    expect(computeBaselines(rows).coinFlipPct).toBe(50);
  });

  it("always-long scores every pick as bullish — here the price always rose, so 100%", () => {
    expect(computeBaselines(rows).alwaysLongPct).toBeCloseTo(100);
  });

  it("buy-hold SPY: +2% over a 1% w1 band is a hit for all, so 100%", () => {
    expect(computeBaselines(rows).buyHoldSpyPct).toBeCloseTo(100);
  });

  it("backtest prior is the mean of the per-pick priors, as a percent", () => {
    expect(computeBaselines(rows).backtestPriorPct).toBeCloseTo(60);
  });

  it("void rows are excluded from every baseline", () => {
    const withVoids = [...rows, ...Array.from({ length: 5 }, () => ({ ...rows[0], void: true }))];
    expect(computeBaselines(withVoids).alwaysLongPct).toBeCloseTo(100);
  });

  it("no priors present → backtestPriorPct is null", () => {
    const noPriors = rows.map((r) => ({ ...r, backtestPrior: null }));
    expect(computeBaselines(noPriors).backtestPriorPct).toBeNull();
  });
});

describe("daysHeld", () => {
  it("counts consecutive same-direction observations from entry", () => {
    expect(daysHeld("bull", ["bullish", "bull", "BUY-bull", "bearish", "bull"])).toBe(3);
  });
  it("stops at the first disagreement", () => {
    expect(daysHeld("bear", ["bearish", "bullish", "bearish"])).toBe(1);
  });
  it("a null/absent direction counts as a disagreement", () => {
    expect(daysHeld("bull", ["bullish", null, "bullish"])).toBe(1);
  });
  it("zero if the thesis never held", () => {
    expect(daysHeld("bull", ["bearish"])).toBe(0);
    expect(daysHeld("bull", [])).toBe(0);
  });
});
