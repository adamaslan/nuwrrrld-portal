import { describe, expect, it } from "vitest";
import { computeDisagreements, extractDirection } from "@/lib/council-critique";

const T1_BULLISH = [
  "OUTLOOK: bullish",
  'BECAUSE: [C1] says "RSI oversold bounce confirmed"',
  "INVALIDATION: close below 180",
  "EXECUTION: entry 185 / stop 180 / target 195",
].join("\n");

const T2_BEARISH = [
  "OUTLOOK: bearish",
  'BECAUSE: [C4] says "valuation stretched vs peers"',
  "INVALIDATION: close above 210",
  "EXECUTION: entry n/a / stop n/a / target 170",
].join("\n");

describe("extractDirection", () => {
  it("parses T1/T2 via the structured scaffold", () => {
    expect(extractDirection("T1", T1_BULLISH)).toBe("bullish");
    expect(extractDirection("T2", T2_BEARISH)).toBe("bearish");
  });

  it("returns null for T1/T2 answers that don't parse", () => {
    expect(extractDirection("T1", "not a structured answer")).toBeNull();
  });

  it("keyword-scans free-prose seats (RISK/MACRO/QUANT)", () => {
    expect(extractDirection("RISK", "This looks bearish — the bearish case dominates here, sell into strength.")).toBe("bearish");
    expect(extractDirection("MACRO", "Rates are supportive, a bullish tailwind for this long trade.")).toBe("bullish");
  });

  it("returns null when the keyword count is tied or absent", () => {
    expect(extractDirection("QUANT", "Confluence score is 45, no strong signal either way.")).toBeNull();
    expect(extractDirection("RISK", "bullish case here, but also a bearish case here.")).toBeNull();
  });

  it("recognizes an explicit neutral conclusion from a free-prose seat", () => {
    expect(extractDirection("QUANT", "Signal is neutral — no clear direction, sit this one out.")).toBe("neutral");
    expect(extractDirection("MACRO", "Rates backdrop is neutral this cycle, hold current position.")).toBe("neutral");
  });
});

describe("computeDisagreements", () => {
  it("finds no disagreement when every seat agrees", () => {
    const result = computeDisagreements([
      { seat: "T1", answer: T1_BULLISH },
      { seat: "T2", answer: T1_BULLISH.replace("stop 180", "stop 179") },
    ]);
    expect(result.majority).toBe("bullish");
    expect(result.disagreeing).toEqual([]);
    expect(result.agreeing.sort()).toEqual(["T1", "T2"].sort());
  });

  it("flags the minority seat as disagreeing", () => {
    const result = computeDisagreements([
      { seat: "T1", answer: T1_BULLISH },
      { seat: "RISK", answer: "Bearish case dominates — a clear bearish setup, sell." },
      { seat: "MACRO", answer: "Rates are a bullish tailwind, bullish backdrop overall." },
    ]);
    expect(result.majority).toBe("bullish");
    expect(result.disagreeing).toEqual(["RISK"]);
    expect(result.agreeing.sort()).toEqual(["T1", "MACRO"].sort());
  });

  it("treats a tie as no majority — nothing flagged as disagreeing", () => {
    const result = computeDisagreements([
      { seat: "T1", answer: T1_BULLISH },
      { seat: "T2", answer: T2_BEARISH },
    ]);
    expect(result.majority).toBeNull();
    expect(result.disagreeing).toEqual([]);
    expect(result.agreeing.sort()).toEqual(["T1", "T2"].sort());
  });

  it("puts unparsable/ambiguous seats in agreeing rather than guessing", () => {
    const result = computeDisagreements([
      { seat: "T1", answer: T1_BULLISH },
      { seat: "T2", answer: T1_BULLISH.replace("bullish", "bullish").replace("EXECUTION", "EXECUTION")}, // still bullish
      { seat: "QUANT", answer: "Confluence score is 45, no strong signal either way." },
    ]);
    expect(result.majority).toBe("bullish");
    expect(result.disagreeing).toEqual([]);
    expect(result.agreeing).toContain("QUANT");
  });
});
