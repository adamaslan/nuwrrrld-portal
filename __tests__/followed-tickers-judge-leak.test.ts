/**
 * followed-tickers judge — outcome-leak guard (plan F11).
 *
 * The judge grades reasoning, not results. If a realized outcome reaches the
 * prompt, the judge grades hindsight and the reasoning score is meaningless.
 * This feeds the prompt builder a verdict object polluted with the fields a
 * scored pick carries, and asserts none of them reach the prompt text.
 */
import { describe, expect, it } from "vitest";
import type { StructuredVerdict } from "@/lib/council-verdict";
import { buildJudgePrompt } from "@/lib/eval-judge";

const CLEAN_VERDICT: StructuredVerdict = {
  outlook: "bullish",
  because: '[C1] says "resolved bullish 71% over 42 occurrences"',
  invalidation: "below 184.30 on a closing basis",
  execution: "entry 185.50 / stop 183.90 / target 192.00",
};
const BRIEF = "=== BACKTEST HIT-RATES ===\n[C1] resolved bullish 71% over 42 occurrences";

/** Outcome-side fields a scored pick carries. None may reach the judge. */
const OUTCOME_FIELDS = {
  outcome: "hit",
  return_pct: 12.34,
  exit_price: 207.91,
  directional: 12.34,
  resolved_on: "2026-06-30",
  judge_score: 9,
};

// Field names and planted values. The prompt legitimately says "no outcome
// information", so the bare word "outcome" is deliberately not checked.
const OUTCOME_FORBIDDEN_TOKENS = [
  "return_pct",
  "exit_price",
  "directional",
  "resolved_on",
  "judge_score",
  "12.34",
  "207.91",
];

describe("judge prompt outcome-leak guard", () => {
  it("does not carry outcome fields from a polluted verdict object", () => {
    const polluted = { ...CLEAN_VERDICT, ...OUTCOME_FIELDS } as StructuredVerdict;
    const prompt = buildJudgePrompt(polluted, BRIEF);
    for (const token of OUTCOME_FORBIDDEN_TOKENS) {
      expect(prompt, `prompt leaked "${token}"`).not.toContain(token);
    }
  });

  it("prompt built from a clean verdict is identical to the polluted one", () => {
    const polluted = { ...CLEAN_VERDICT, ...OUTCOME_FIELDS } as StructuredVerdict;
    expect(buildJudgePrompt(polluted, BRIEF)).toBe(buildJudgePrompt(CLEAN_VERDICT, BRIEF));
  });
});
