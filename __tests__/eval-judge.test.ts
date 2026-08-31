/**
 * eval-judge — unit tests for the LLM-as-judge rubric, parser, and gold gate.
 * Pure: the model call is injected, so no network or quota is touched.
 */
import { describe, expect, it } from "vitest";
import type { StructuredVerdict } from "@/lib/council-verdict";
import {
  buildJudgePrompt,
  compareToGold,
  evaluateGoldGate,
  GOLD_AGREEMENT_THRESHOLD,
  JUDGE_CRITERIA,
  judgeVerdict,
  MAX_JUDGE_SCORE,
  parseJudgeResponse,
  type GoldComparison,
} from "@/lib/eval-judge";

const VERDICT: StructuredVerdict = {
  outlook: "bullish",
  because: '[C1] says "resolved bullish 71% over 42 occurrences"',
  invalidation: "below 184.30 on a closing basis",
  execution: "entry 185.50 / stop 183.90 / target 192.00",
};
const BRIEF = "=== BACKTEST HIT-RATES ===\n[C1] resolved bullish 71% over 42 occurrences";

describe("buildJudgePrompt", () => {
  it("includes the verdict and the brief", () => {
    const p = buildJudgePrompt(VERDICT, BRIEF);
    expect(p).toContain("184.30");
    expect(p).toContain("[C1] resolved bullish 71%");
  });
  it("never leaks outcome-shaped information", () => {
    const p = buildJudgePrompt(VERDICT, BRIEF).toLowerCase();
    expect(p).not.toContain("realized");
    expect(p).not.toContain("actual price");
    expect(p).toContain("no outcome information");
  });
  it("asks for exactly the five rubric lines", () => {
    const p = buildJudgePrompt(VERDICT, BRIEF);
    for (const c of JUDGE_CRITERIA) {
      expect(p.toUpperCase()).toContain(`${c.toUpperCase()}:`);
    }
  });
});

describe("parseJudgeResponse", () => {
  it("parses five well-formed lines", () => {
    const raw = [
      "GROUNDING: 2 — quotes C1 exactly",
      "FALSIFIABILITY: 2 — names 184.30",
      "CONSISTENCY: 2 — all bullish",
      "SPECIFICITY: 1 — could be tighter",
      "CALIBRATION: 2 — matches evidence",
    ].join("\n");
    const r = parseJudgeResponse(raw);
    expect(r).not.toBeNull();
    expect(r!.total).toBe(9);
    expect(r!.scores.specificity).toBe(1);
    expect(r!.justifications.grounding).toBe("quotes C1 exactly");
    expect(MAX_JUDGE_SCORE).toBe(10);
  });

  it("tolerates surrounding prose and different dashes", () => {
    const raw = [
      "Here is my assessment:",
      "GROUNDING: 0 - fabricated",
      "FALSIFIABILITY: 0 – vague",
      "CONSISTENCY: 1",
      "SPECIFICITY: 0 — generic",
      "CALIBRATION: 1 — overconfident",
      "Overall this is weak.",
    ].join("\n");
    const r = parseJudgeResponse(raw);
    expect(r!.total).toBe(2);
  });

  it("returns null when a criterion is missing", () => {
    const raw = ["GROUNDING: 2", "FALSIFIABILITY: 2", "CONSISTENCY: 2", "SPECIFICITY: 2"].join("\n");
    expect(parseJudgeResponse(raw)).toBeNull();
  });

  it("returns null on an out-of-range score", () => {
    const raw = [
      "GROUNDING: 3 — too high",
      "FALSIFIABILITY: 2",
      "CONSISTENCY: 2",
      "SPECIFICITY: 2",
      "CALIBRATION: 2",
    ].join("\n");
    expect(parseJudgeResponse(raw)).toBeNull();
  });
});

describe("compareToGold — agreement is ±1 on the 0..10 sum", () => {
  const judge = (total: number) => ({
    scores: { grounding: 0, falsifiability: 0, consistency: 0, specificity: 0, calibration: 0 } as const,
    total,
    justifications: {} as never,
  });
  it("within 1 point agrees", () => {
    expect(compareToGold("g", 8, judge(9)).agrees).toBe(true);
    expect(compareToGold("g", 8, judge(7)).agrees).toBe(true);
  });
  it("more than 1 point disagrees", () => {
    expect(compareToGold("g", 8, judge(6)).agrees).toBe(false);
    expect(compareToGold("g", 1, judge(10)).agrees).toBe(false);
  });
});

describe("evaluateGoldGate", () => {
  const cmp = (agrees: boolean): GoldComparison => ({ id: "x", goldTotal: 5, judgeTotal: 5, agrees });

  it("passes at exactly the threshold", () => {
    const comps = [
      ...Array.from({ length: 8 }, () => cmp(true)),
      ...Array.from({ length: 2 }, () => cmp(false)),
    ];
    const g = evaluateGoldGate(comps);
    expect(g.agreementRate).toBeCloseTo(GOLD_AGREEMENT_THRESHOLD);
    expect(g.passed).toBe(true);
  });

  it("fails just below the threshold", () => {
    const comps = [
      ...Array.from({ length: 7 }, () => cmp(true)),
      ...Array.from({ length: 3 }, () => cmp(false)),
    ];
    expect(evaluateGoldGate(comps).passed).toBe(false);
  });

  it("an empty gold set is a hard fail, not a vacuous pass", () => {
    const g = evaluateGoldGate([]);
    expect(g.passed).toBe(false);
    expect(g.agreementRate).toBe(0);
  });
});

describe("judgeVerdict", () => {
  it("returns a parsed result when the injected call is well-formed", async () => {
    const call = async () =>
      [
        "GROUNDING: 2 — ok",
        "FALSIFIABILITY: 2 — ok",
        "CONSISTENCY: 2 — ok",
        "SPECIFICITY: 2 — ok",
        "CALIBRATION: 2 — ok",
      ].join("\n");
    const r = await judgeVerdict(VERDICT, BRIEF, call);
    expect(r!.total).toBe(10);
  });

  it("returns null when the model response is unparseable", async () => {
    const r = await judgeVerdict(VERDICT, BRIEF, async () => "I think it's pretty good.");
    expect(r).toBeNull();
  });
});
