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

const TWO_RULE_BRIEF = `DATA
RSI: 72.0
MACD: positive

RULES
[C1] Recent momentum remains elevated: "RSI is 72.0" — fixture
[C2] Trend confirmation is positive: "MACD is positive" — fixture
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

  it("rejects exponent and suffixed numeric prefixes in execution levels", () => {
    for (const execution of [
      "entry 1e4 / stop 0.5 / target 2",
      "entry 1,234.5x / stop 0.5 / target 2",
      "entry 1 / stop 0.5 / target 2%",
      "entry -1 / stop 0.5 / target 2",
    ]) {
      expect(
        simulateJudge({ ...VERDICT, execution }, `DATA\nEntry 1; stop 0.5; target 2.\n\nRULES\n[C1] momentum: "RSI is 72.0"`)
          .scores.consistency,
        execution,
      ).toBe(1);
    }
  });

  it("keeps each evidence quote attached to its cited rule id", () => {
    const swapped = simulateJudge(
      { ...VERDICT, because: '[C1] says "MACD is positive" [C2] says "RSI is 72.0"' },
      TWO_RULE_BRIEF,
    );
    const exact = simulateJudge(
      { ...VERDICT, because: '[C1] says "RSI is 72.0" [C2] says "MACD is positive"' },
      TWO_RULE_BRIEF,
    );

    expect(swapped.scores.grounding).toBe(0);
    expect(exact.scores.grounding).toBe(2);
  });

  it("requires a concrete condition for nonnumeric invalidation references", () => {
    expect(simulateJudge({ ...VERDICT, invalidation: "price below" }, BRIEF).scores.falsifiability).toBe(1);
    expect(
      simulateJudge({ ...VERDICT, invalidation: "price below the moving average" }, BRIEF).scores.falsifiability,
    ).toBe(2);
  });

  it("checks explicit BECAUSE direction without treating quoted evidence as the verdict", () => {
    const opposed = simulateJudge(
      { ...VERDICT, because: '[C1] says "RSI is 72.0"; bearish case because momentum is weakening' },
      BRIEF,
    );
    const quotedCounter = simulateJudge(
      {
        ...VERDICT,
        because: '[C1] says "bearish case" and RSI is 72.0',
        execution: "entry 1,234 / stop 1,200 / target 1,300",
      },
      LEVEL_BRIEF,
    );

    expect(opposed.scores.consistency).toBe(0);
    expect(quotedCounter.scores.consistency).toBe(2);
  });

  it("does not let mixed BECAUSE directions hide invalid EXECUTION levels", () => {
    const mixedBecause = '[C1] says "RSI is 72.0"; bullish case has momentum; bearish case has downside risk';
    const invalidOrder = simulateJudge(
      { ...VERDICT, because: mixedBecause, execution: "entry 100 / stop 110 / target 90" },
      `DATA\nEntry 100; stop 110; target 90.\n\nRULES\n[C1] momentum: "RSI is 72.0"`,
    );
    const validOrder = simulateJudge(
      {
        ...VERDICT,
        because: mixedBecause,
        execution: "entry 100 / stop 90 / target 110",
      },
      `DATA\nEntry 100; stop 90; target 110.\n\nRULES\n[C1] momentum: "RSI is 72.0"`,
    );

    expect(invalidOrder.scores.consistency).toBe(0);
    expect(validOrder.scores.consistency).toBe(1);
  });

  it("does not give full credit to an untestable hold condition", () => {
    expect(simulateJudge({ ...VERDICT, invalidation: "price holds forever" }, BRIEF).scores.falsifiability).toBe(1);
    expect(
      simulateJudge({ ...VERDICT, invalidation: "price holds below the 50-day moving average" }, BRIEF)
        .scores.falsifiability,
    ).toBe(2);
  });
});
