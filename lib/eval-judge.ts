/**
 * eval-judge — LLM-as-judge scoring for followed-tickers council verdicts
 * (docs/tickers-followed.md §"Scoring: LLM as judge").
 *
 * This module is the rubric, the prompt builder, the response parser, and the
 * gold-set gate. The actual model call is *injected* (a `JudgeCall` function),
 * so everything here is pure and unit-testable without a network or quota.
 *
 * The judge only ever sees verdicts that lib/council-validate.ts has already
 * passed — arithmetic/trade-logic failures are caught deterministically first,
 * and letting the judge grade a verdict with a hallucinated number teaches the
 * scoreboard that fabrication is a style problem rather than a disqualifying
 * one.
 */

import type { StructuredVerdict } from "@/lib/council-verdict";

/** Current rubric version. Changing the rubric or the judge model starts a new
 *  scoring series — judge scores are comparable only within a version. */
export const JUDGE_VERSION = "v1";

/** Gold-set agreement below this fraction discards the whole run's scores. */
export const GOLD_AGREEMENT_THRESHOLD = 0.8;

/** Per-criterion score is 0 (absent/violated), 1 (partial), or 2 (fully met). */
export type CriterionScore = 0 | 1 | 2;

export const JUDGE_CRITERIA = [
  "grounding",
  "falsifiability",
  "consistency",
  "specificity",
  "calibration",
] as const;
export type Criterion = (typeof JUDGE_CRITERIA)[number];

export const MAX_JUDGE_SCORE = JUDGE_CRITERIA.length * 2; // 10

export interface JudgeScores {
  grounding: CriterionScore;
  falsifiability: CriterionScore;
  consistency: CriterionScore;
  specificity: CriterionScore;
  calibration: CriterionScore;
}

export interface JudgeResult {
  scores: JudgeScores;
  total: number;
  justifications: Record<Criterion, string>;
}

const CRITERION_PROMPT: Record<Criterion, string> = {
  grounding:
    "BECAUSE cites an evidence id from RULES and quotes it exactly, rather than composing a plausible-sounding sentence.",
  falsifiability:
    'INVALIDATION names a specific price level or observable condition. "If the trend reverses" scores 0; "below $187.40" scores 2.',
  consistency:
    "OUTLOOK, BECAUSE, and EXECUTION describe the same trade. A bullish outlook with a short-shaped execution scores 0.",
  specificity:
    "Concrete levels and timeframes over hedged prose. Generic market commentary that would fit any ticker scores 0.",
  calibration:
    "Stated confidence matches the strength of the cited evidence — no `high` confidence resting on one weak signal.",
};

/**
 * Build the judge prompt. It contains the verdict and the brief it was
 * grounded on — and NOTHING that reveals the outcome: no realized price, no
 * resolved outcome, no current date relative to the pick. A judge that can see
 * the answer grades hindsight.
 */
export function buildJudgePrompt(verdict: StructuredVerdict, brief: string): string {
  const criteriaLines = JUDGE_CRITERIA.map(
    (c, i) => `${i + 1}. ${c}: ${CRITERION_PROMPT[c]}`,
  );
  return [
    "You are grading the QUALITY OF REASONING in a trading verdict. You are NOT",
    "predicting whether it will be right — you have no outcome information and",
    "must not speculate about one.",
    "",
    "=== BRIEF THE VERDICT WAS GROUNDED ON ===",
    brief,
    "",
    "=== VERDICT ===",
    `OUTLOOK: ${verdict.outlook}`,
    `BECAUSE: ${verdict.because}`,
    `INVALIDATION: ${verdict.invalidation}`,
    `EXECUTION: ${verdict.execution}`,
    "",
    "=== RUBRIC ===",
    "Score each criterion 0 (absent/violated), 1 (partial), or 2 (fully met).",
    ...criteriaLines,
    "",
    "Respond with ONLY these five lines, in this exact order, nothing else:",
    "GROUNDING: <0|1|2> — <one-line justification>",
    "FALSIFIABILITY: <0|1|2> — <one-line justification>",
    "CONSISTENCY: <0|1|2> — <one-line justification>",
    "SPECIFICITY: <0|1|2> — <one-line justification>",
    "CALIBRATION: <0|1|2> — <one-line justification>",
  ].join("\n");
}

const LINE_RE = /^([A-Z]+)\s*:\s*([012])\s*(?:[—–-]\s*(.*))?$/;

/**
 * Parse the five-line judge response. Returns null if any criterion is missing
 * or its score isn't 0/1/2 — a partial parse is a run failure, not a silent
 * default, exactly as parseStructuredVerdict treats a missing field.
 */
export function parseJudgeResponse(raw: string): JudgeResult | null {
  const found = new Map<Criterion, { score: CriterionScore; why: string }>();
  for (const line of raw.split("\n")) {
    const m = line.trim().match(LINE_RE);
    if (!m) continue;
    const key = m[1].toLowerCase() as Criterion;
    if (!JUDGE_CRITERIA.includes(key)) continue;
    found.set(key, { score: Number(m[2]) as CriterionScore, why: (m[3] ?? "").trim() });
  }

  if (found.size !== JUDGE_CRITERIA.length) return null;

  const scores = {} as JudgeScores;
  const justifications = {} as Record<Criterion, string>;
  for (const c of JUDGE_CRITERIA) {
    const entry = found.get(c)!;
    scores[c] = entry.score;
    justifications[c] = entry.why;
  }
  const total = JUDGE_CRITERIA.reduce((sum, c) => sum + scores[c], 0);
  return { scores, total, justifications };
}

/** One hand-scored gold-set entry (see __tests__/fixtures/followed-tickers-gold-set.json). */
export interface GoldEntry {
  id: string;
  verdict: StructuredVerdict;
  brief: string;
  /** The human total, 0..10. */
  goldTotal: number;
}

/** A judged gold entry: the human total next to what the judge produced now. */
export interface GoldComparison {
  id: string;
  goldTotal: number;
  judgeTotal: number;
  /** Agreement is "within 1 point of the human total" per criterion-sum. */
  agrees: boolean;
}

/** ±1 point on the 0..10 total counts as agreement with the human score. */
export const GOLD_AGREEMENT_TOLERANCE = 1;

export function compareToGold(id: string, goldTotal: number, judge: JudgeResult): GoldComparison {
  return {
    id,
    goldTotal,
    judgeTotal: judge.total,
    agrees: Math.abs(goldTotal - judge.total) <= GOLD_AGREEMENT_TOLERANCE,
  };
}

export interface GoldGateResult {
  agreementRate: number;
  passed: boolean;
  comparisons: GoldComparison[];
}

/**
 * Run the judge over the whole gold set and decide whether this run's scores
 * may be published. If agreement drops below GOLD_AGREEMENT_THRESHOLD the run
 * is discarded — the only defense against silent judge drift when the free-tier
 * model chain swaps a model out from under the harness.
 */
export function evaluateGoldGate(comparisons: readonly GoldComparison[]): GoldGateResult {
  if (comparisons.length === 0) {
    // No gold set = judge rule 5 is unenforceable = the judge column is
    // unfalsifiable. Treat as a hard fail rather than a vacuous pass.
    return { agreementRate: 0, passed: false, comparisons: [] };
  }
  const agree = comparisons.filter((c) => c.agrees).length;
  const rate = agree / comparisons.length;
  return {
    agreementRate: rate,
    passed: rate >= GOLD_AGREEMENT_THRESHOLD,
    comparisons: [...comparisons],
  };
}

export type JudgeCall = (prompt: string) => Promise<string>;

/**
 * Score one verdict end-to-end: build prompt → call model → parse. Returns null
 * on an unparseable response so the caller can retry once or drop the verdict
 * from the sample rather than record a fabricated score.
 */
export async function judgeVerdict(
  verdict: StructuredVerdict,
  brief: string,
  call: JudgeCall,
): Promise<JudgeResult | null> {
  const raw = await call(buildJudgePrompt(verdict, brief));
  return parseJudgeResponse(raw);
}
