import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  DEAD_BAND_PCT,
  HORIZONS,
  scorePick,
  type Horizon,
} from "@/lib/eval-scoring";

/**
 * T-090/094/098/102/106/110/114: the hit/void boundary at tau for every
 * horizon, both directions. classifyOutcome takes the directional return
 * directly, so the boundary cases use exact decimals - no float wobble.
 * T-119: direction-aware scoring through scorePick with real prices, at a
 * clear margin (3% vs the m1 band of 2%) so float noise cannot flip the case.
 */

const EPS = 0.0001;

describe("hit/void boundary at tau, every horizon (T-090/094/098/102/106/110/114)", () => {
  for (const horizon of HORIZONS) {
    const tau = DEAD_BAND_PCT[horizon];
    it(`${horizon} (tau=${tau}%): +tau exactly is flat, +tau+eps is a hit`, () => {
      expect(classifyOutcome(tau, horizon)).toBe("flat");
      expect(classifyOutcome(tau + EPS, horizon)).toBe("hit");
    });
    it(`${horizon} (tau=${tau}%): -tau exactly is flat, -tau-eps is a miss`, () => {
      expect(classifyOutcome(-tau, horizon)).toBe("flat");
      expect(classifyOutcome(-tau - EPS, horizon)).toBe("miss");
    });
    it(`${horizon}: zero move is flat`, () => {
      expect(classifyOutcome(0, horizon)).toBe("flat");
    });
  }
});

describe("direction-aware scoring through scorePick (T-119)", () => {
  // m1 band is 2%; all moves below are 3% - clearly outside the band.
  const horizon: Horizon = "m1";

  it("a bull pick scores a hit when price rises 3%", () => {
    const s = scorePick({ direction: "bull", entryPrice: 100, exitPrice: 103, horizon });
    expect(s.outcome).toBe("hit");
    expect(s.directional).toBeGreaterThan(2);
  });

  it("a bear pick scores a hit when price falls 3% (down move pays the short)", () => {
    const s = scorePick({ direction: "bear", entryPrice: 100, exitPrice: 97, horizon });
    expect(s.outcome).toBe("hit");
    expect(s.directional).toBeGreaterThan(2);
  });

  it("a bear pick scores a miss when price rises 3% (up move hurts the short)", () => {
    const s = scorePick({ direction: "bear", entryPrice: 100, exitPrice: 103, horizon });
    expect(s.outcome).toBe("miss");
    expect(s.directional).toBeLessThan(-2);
  });

  it("a bull pick scores a miss when price falls 3%", () => {
    const s = scorePick({ direction: "bull", entryPrice: 100, exitPrice: 97, horizon });
    expect(s.outcome).toBe("miss");
    expect(s.directional).toBeLessThan(-2);
  });

  it("a small adverse move inside the band is flat, not a miss (bear, -1% vs tau=2%)", () => {
    const s = scorePick({ direction: "bear", entryPrice: 100, exitPrice: 101, horizon });
    expect(s.outcome).toBe("flat");
  });
});
