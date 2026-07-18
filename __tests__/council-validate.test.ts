import { describe, expect, it } from "vitest";
import {
  buildRepairMessage,
  numericCrossCheck,
  tradeLogicSanity,
  validateStructuredVerdict,
} from "@/lib/council-validate";
import type { StructuredVerdict } from "@/lib/council-verdict";

const BRIEF = [
  "QUESTION: should I trade AAPL",
  "=== LIVE SIGNAL DATA (AAPL) ===",
  "Confluence score: 72",
  "RULES (choose from these only):",
  '[C1] "RSI 28.40 with rising volume signals a bounce" — swing-notes.md',
].join("\n");

function verdict(overrides: Partial<StructuredVerdict> = {}): StructuredVerdict {
  return {
    outlook: "bullish",
    because: '[C1] says "RSI 28.40 with rising volume signals a bounce"',
    invalidation: "close below 182.00",
    execution: "entry 185.00 / stop 182.00 / target 195.00",
    ...overrides,
  };
}

describe("numericCrossCheck", () => {
  it("passes when every number in the verdict is grounded in the brief", () => {
    // 185.00, 182.00, 195.00 aren't literally in BRIEF but 28.40 and 72 are —
    // use a verdict whose numbers are all present in the brief.
    const grounded = verdict({
      because: '[C1] says "RSI 28.40 with rising volume signals a bounce"',
      invalidation: "confluence score below 72",
      execution: "entry n/a / stop n/a / target n/a",
    });
    expect(numericCrossCheck(grounded, BRIEF)).toEqual([]);
  });

  it("flags a number invented by the model", () => {
    const flags = numericCrossCheck(
      verdict({ because: '[C1] says "RSI 31.2 confirms the setup"' }),
      BRIEF,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0].field).toBe("BECAUSE");
    expect(flags[0].message).toContain("31.2");
  });

  it("tolerates numbers within ±1%", () => {
    const flags = numericCrossCheck(
      verdict({
        because: '[C1] says "confluence near 72.3"',
        invalidation: "confluence score below 72",
        execution: "entry n/a / stop n/a / target n/a",
      }),
      BRIEF,
    );
    expect(flags).toEqual([]);
  });

  it("does not flag the id inside [C1] as an invented number", () => {
    const groundedOnly = verdict({
      because: '[C1] says "RSI 28.40 with rising volume signals a bounce"',
      invalidation: "confluence score below 72",
      execution: "entry n/a / stop n/a / target n/a",
    });
    // If [C1]'s "1" were treated as data, this would flag — it must not.
    expect(numericCrossCheck(groundedOnly, BRIEF)).toEqual([]);
  });
});

describe("tradeLogicSanity", () => {
  it("passes a correctly ordered long", () => {
    expect(tradeLogicSanity(verdict())).toEqual([]);
  });

  it("flags a long with stop above entry", () => {
    const flags = tradeLogicSanity(
      verdict({ execution: "entry 185.00 / stop 190.00 / target 195.00" }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toContain("stop < entry < target");
  });

  it("passes a correctly ordered short (bearish)", () => {
    const flags = tradeLogicSanity(
      verdict({ outlook: "bearish", execution: "entry 185.00 / stop 190.00 / target 175.00" }),
    );
    expect(flags).toEqual([]);
  });

  it("flags a short with target above entry", () => {
    const flags = tradeLogicSanity(
      verdict({ outlook: "bearish", execution: "entry 185.00 / stop 190.00 / target 195.00" }),
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].message).toContain("target < entry < stop");
  });

  it("skips neutral calls and unparseable execution fields", () => {
    expect(tradeLogicSanity(verdict({ outlook: "neutral" }))).toEqual([]);
    expect(tradeLogicSanity(verdict({ execution: "entry n/a / stop n/a / target n/a" }))).toEqual([]);
  });
});

describe("validateStructuredVerdict + buildRepairMessage", () => {
  it("combines both checks and produces a mechanical, non-evaluative message", () => {
    const bad = verdict({
      because: '[C1] says "RSI 31.2 confirms the setup"', // ungrounded number
      invalidation: "confluence score below 72", // grounded — no flag
      execution: "entry 72.3 / stop 72.4 / target 72.5", // grounded, but misordered for a long
    });
    const flags = validateStructuredVerdict(bad, BRIEF);
    expect(flags.length).toBe(2);

    const message = buildRepairMessage(flags);
    expect(message).not.toMatch(/please improve/i);
    expect(message).toContain("31.2");
    expect(message).toContain("stop < entry < target");
  });
});
