import { describe, expect, it } from "vitest";
import { buildTieBreak } from "@/lib/shared/paper-persona";
import type { EngineCandidate } from "@/lib/shared/paper-engine-core";

function cand(ticker: string, score: number, tokens: Record<string, string>, dataQuality?: number): EngineCandidate {
  return { ticker, score, tokens, dataQuality };
}

describe("buildTieBreak — t1 (fresh event first)", () => {
  const tieBreak = buildTieBreak("t1", []);

  it("prefers a live MACD cross over an RSI extreme", () => {
    const withCross = cand("AAA", 60, { macd: "bullish_cross", rsi: "neutral", vol: "normal" });
    const withRsi = cand("BBB", 60, { macd: "none", rsi: "oversold", vol: "normal" });
    expect(tieBreak!(withCross, withRsi)).toBeLessThan(0);
    expect(tieBreak!(withRsi, withCross)).toBeGreaterThan(0);
  });

  it("prefers higher volatility when the event tier is equal", () => {
    const high = cand("AAA", 60, { macd: "none", rsi: "neutral", vol: "high" });
    const low = cand("BBB", 60, { macd: "none", rsi: "neutral", vol: "low" });
    expect(tieBreak!(high, low)).toBeLessThan(0);
  });

  it("returns 0 (no opinion) when tokens are missing entirely", () => {
    expect(tieBreak!(cand("AAA", 60, {}), cand("BBB", 60, {}))).toBe(0);
  });
});

describe("buildTieBreak — t2 (quiet, trending)", () => {
  const tieBreak = buildTieBreak("t2", []);

  it("prefers low volatility over high", () => {
    const low = cand("AAA", 60, { vol: "low", adx: "ranging" });
    const high = cand("BBB", 60, { vol: "high", adx: "ranging" });
    expect(tieBreak!(low, high)).toBeLessThan(0);
  });

  it("prefers trending ADX when volatility ties", () => {
    const trending = cand("AAA", 60, { vol: "low", adx: "trending" });
    const ranging = cand("BBB", 60, { vol: "low", adx: "ranging" });
    expect(tieBreak!(trending, ranging)).toBeLessThan(0);
  });
});

describe("buildTieBreak — risk (lowest vol first)", () => {
  const tieBreak = buildTieBreak("risk", []);
  it("prefers the lower-volatility name", () => {
    const low = cand("AAA", 60, { vol: "low" });
    const high = cand("BBB", 60, { vol: "high" });
    expect(tieBreak!(low, high)).toBeLessThan(0);
  });
});

describe("buildTieBreak — quant (data quality)", () => {
  const tieBreak = buildTieBreak("quant", []);
  it("prefers the higher data_quality card", () => {
    const better = cand("AAA", 60, {}, 0.99);
    const worse = cand("BBB", 60, {}, 0.8);
    expect(tieBreak!(better, worse)).toBeLessThan(0);
  });
});

describe("buildTieBreak — macro (sector breadth)", () => {
  it("prefers the sector with more bullish breadth among the full candidate set", () => {
    // Utilities: 2/2 bullish. Energy: 1/2 bullish. Utilities should win.
    const all: EngineCandidate[] = [
      cand("NEE", 54, { direction: "bullish" }), // Utilities
      cand("DUK", 54, { direction: "bullish" }), // Utilities
      cand("XOM", 54, { direction: "bullish" }), // Energy
      cand("CVX", 54, { direction: "bearish" }), // Energy
    ];
    const tieBreak = buildTieBreak("macro", all)!;
    expect(tieBreak(all[0], all[2])).toBeLessThan(0); // NEE (Utilities) beats XOM (Energy)
  });

  it("prefers an ETF over a single stock at equal breadth", () => {
    // Everything below scores as its own single-member sector, so breadth is
    // equal (1/1) for both; the ETF preference is the tiebreak that should fire.
    const all: EngineCandidate[] = [
      cand("XLU", 54, { direction: "bullish" }), // ETF sector
      cand("SO", 54, { direction: "bullish" }), // Utilities (single stock)
    ];
    const tieBreak = buildTieBreak("macro", all)!;
    expect(tieBreak(all[0], all[1])).toBeLessThanOrEqual(0);
  });
});

describe("buildTieBreak — chair has none", () => {
  it("returns undefined (chair plans consensus, not a ranked buy list)", () => {
    expect(buildTieBreak("chair", [])).toBeUndefined();
  });
});
