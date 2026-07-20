import { describe, expect, it } from "vitest";
import {
  directionFromOutlook,
  parseStructuredVerdict,
  stripReasoning,
} from "@/lib/council-verdict";

describe("parseStructuredVerdict — 4-field scaffold", () => {
  it("parses a well-formed response", () => {
    const raw = [
      "OUTLOOK: bullish",
      'BECAUSE: [C1] says "RSI above 70 with declining volume precedes mean reversion"',
      "INVALIDATION: close below 182.50",
      "EXECUTION: entry 185.00 / stop 182.50 / target 195.00",
    ].join("\n");
    const verdict = parseStructuredVerdict(raw);
    expect(verdict).not.toBeNull();
    expect(verdict?.outlook).toBe("bullish");
    expect(verdict?.because).toContain("[C1]");
    expect(verdict?.invalidation).toBe("close below 182.50");
    expect(verdict?.execution).toContain("target 195.00");
  });

  it("returns null when a required field is missing", () => {
    const raw = ["OUTLOOK: bullish", "BECAUSE: [C1] says \"x\""].join("\n");
    expect(parseStructuredVerdict(raw)).toBeNull();
  });

  it("regression: rejects an OUTLOOK outside the enum instead of silently defaulting to neutral (PR #34 review)", () => {
    const raw = [
      "OUTLOOK: sideways and uncertain",
      'BECAUSE: [C1] says "no clear signal"',
      "INVALIDATION: n/a",
      "EXECUTION: entry n/a / stop n/a / target n/a",
    ].join("\n");
    expect(parseStructuredVerdict(raw)).toBeNull();
  });

  it("accepts OUTLOOK case-insensitively", () => {
    const raw = [
      "OUTLOOK: Bullish",
      'BECAUSE: [C1] says "x"',
      "INVALIDATION: y",
      "EXECUTION: z",
    ].join("\n");
    expect(parseStructuredVerdict(raw)?.outlook).toBe("Bullish");
  });

  it("regression: strips chain-of-thought preamble before the first field label (2026-07-15 audit finding)", () => {
    const raw = [
      "The user wants a 1-5 day trade framing. I need to extract specific numbers",
      "from the data before I answer. Let me think through the RSI and MACD...",
      "",
      "OUTLOOK: bearish",
      'BECAUSE: [C2] says "ADX below 20 signals a ranging market"',
      "INVALIDATION: close above 210.00",
      "EXECUTION: entry 198.00 / stop 210.00 / target 180.00",
    ].join("\n");
    const verdict = parseStructuredVerdict(raw);
    expect(verdict).not.toBeNull();
    expect(verdict?.outlook).toBe("bearish");
  });

  it("strips <think> and [thinking] blocks", () => {
    const raw =
      "<think>reasoning about the trade here</think>\n" +
      "OUTLOOK: neutral\n" +
      'BECAUSE: [C3] says "no clear signal"\n' +
      "INVALIDATION: n/a\n" +
      "EXECUTION: entry n/a / stop n/a / target n/a";
    const verdict = parseStructuredVerdict(raw);
    expect(verdict?.outlook).toBe("neutral");
  });
});

describe("stripReasoning", () => {
  it("is a no-op on already-clean input", () => {
    const clean = "OUTLOOK: bullish\nBECAUSE: x\nINVALIDATION: y\nEXECUTION: z";
    expect(stripReasoning(clean)).toBe(clean);
  });
});

describe("directionFromOutlook", () => {
  it("maps case-insensitively and defaults to neutral", () => {
    expect(directionFromOutlook("Bullish")).toBe("bullish");
    expect(directionFromOutlook("BEARISH")).toBe("bearish");
    expect(directionFromOutlook("sideways / unclear")).toBe("neutral");
  });
});
