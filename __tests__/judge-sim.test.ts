import { describe, expect, it } from "vitest";
import type { StructuredVerdict } from "@/lib/council-verdict";
import { simulateJudge } from "@/lib/judge-sim";

const BRIEF = `DATA
RSI: 72.0

RULES
[C1] Recent momentum remains elevated: "RSI is 72.0" — fixture
`;

const LEVEL_BRIEF = `DATA
Entry 1,234; stop 1,200; target 1,300.
Alternate entry 900; stop 1,000; target 950.

RULES
[C1] Recent momentum remains elevated: "RSI is 72.0" — fixture
`;

const VERDICT: StructuredVerdict = {
  outlook: "bullish",
  because: '[C1] says "RSI is 72.0" — fixture',
  invalidation: "price falls",
  execution: "entry $145 / stop $140 / target $155 in 1-5 days",
};

describe("simulateJudge", () => {
  it("scores named but unspecified invalidation as partial, not a triggered condition", () => {
    const partial = simulateJudge(VERDICT, BRIEF);
    const vague = simulateJudge({ ...VERDICT, invalidation: "if the trend reverses" }, BRIEF);

    expect(partial.scores.falsifiability).toBe(1);
    expect(vague.scores.falsifiability).toBe(0);
  });

  it("recognizes spaced and unspaced indicator comparisons and one-digit prices", () => {
    for (const invalidation of ["RSI > 70", "RSI>70", "below $9.50", "below 1,234.50"]) {
      expect(simulateJudge({ ...VERDICT, invalidation }, BRIEF).scores.falsifiability, invalidation).toBe(2);
    }

    expect(
      simulateJudge({ ...VERDICT, invalidation: "below 9.50 in 1-5 days" }, BRIEF).scores.specificity,
    ).toBe(2);
  });

  it("requires grounded execution levels and checks comma-formatted ordering", () => {
    const valid = simulateJudge(
      { ...VERDICT, execution: "entry 1,234 / stop 1,200 / target 1,300" },
      LEVEL_BRIEF,
    );
    const invalid = simulateJudge(
      { ...VERDICT, execution: "entry 900 / stop 1,000 / target 950" },
      LEVEL_BRIEF,
    );
    const unsupported = simulateJudge(VERDICT, BRIEF);

    expect(valid.scores.consistency).toBe(2);
    expect(invalid.scores.consistency).toBe(0);
    expect(unsupported.scores.consistency).toBe(0);
  });

  it("does not score partial matches of malformed execution numbers", () => {
    for (const execution of [
      "entry 1.23456 / stop 1.2 / target 2",
      "entry 1,23 / stop 0.5 / target 2",
      "entry 1,2345 / stop 0.5 / target 2",
    ]) {
      expect(simulateJudge({ ...VERDICT, execution }, LEVEL_BRIEF).scores.consistency, execution).toBe(1);
    }
  });
});
