/**
 * Deterministic approximation of the followed-tickers Judge rubric.
 *
 * This is not a Judge run or a backtest. Results are explicitly labeled
 * SIMULATED and use their own version so they cannot be confused with the
 * quota-bearing `JUDGE_VERSION` series in eval-judge.ts. Inputs are limited
 * to the grounded brief and structured verdict; no realized outcome or date
 * is accepted or consulted.
 */
import type { StructuredVerdict } from "@/lib/council-verdict";
import { directionFromOutlook } from "@/lib/council-verdict";
import type { Criterion, CriterionScore, JudgeResult } from "@/lib/eval-judge";

export const JUDGE_SIM_VERSION = "judge_sim_v1";
export const JUDGE_SIM_LABEL = "SIMULATED" as const;

export type DeclaredConfidence = "low" | "medium" | "high";

export interface SimulatedJudgeResult extends JudgeResult {
  label: typeof JUDGE_SIM_LABEL;
  version: typeof JUDGE_SIM_VERSION;
}

interface RuleEvidence {
  id: string;
  text: string;
}

const EVIDENCE_ID_RE = /\[C\d+\]/gi;
const RULES_HEADER_RE = /^\s*RULES(?:\s*\([^\n]*\))?\s*:?\s*$/im;
const SECTION_HEADER_RE = /^\s*(?:={2,}[^\n]+={2,}|[A-Z][A-Z /_-]{2,}:)\s*$/m;
const PRICE_NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,4})?`;
const PRICE_LEVEL_RE = new RegExp(
  String.raw`(?:\$\s*${PRICE_NUMBER}|\b(?:below|above|over|under|entry|stop|target|level|price|EMA|SMA|VWAP)\s+(?:at\s+)?\$?${PRICE_NUMBER}\b)`,
  "i",
);
const TRIGGERED_PRICE_RE = new RegExp(
  String.raw`\b(?:below|under|beneath|above|over|exceed(?:s|ed)?|close[sd]?\s+(?:below|under|above|over)|break(?:s|out)?\s+(?:below|above))\s+\$?${PRICE_NUMBER}\b`,
  "i",
);
const TIMEFRAME_RE = /\b(?:\d+\s*[-–]\s*\d+\s*(?:trading\s+)?(?:days?|d|weeks?|w|months?|m|years?|y)|\d+\s*(?:minute|hour|day|week|month|year)s?|\b(?:daily|weekly|monthly|quarterly|intraday)\b)\b/i;
const NAMED_OBSERVABLE_RE = /\b(?:close|closing|price|RSI|MACD|EMA|SMA|VWAP|volume|ATR|ADX|spread|yield|rate|gap|high|low)\b/i;
const EXPLICIT_CONDITION_RE = /\b(?:above|below|over|under|cross(?:es|ed)?|break(?:s|out)?|reclaim(?:s|ed)?|lose(?:s|t)?|hold(?:s)?|expand(?:s|ed)?|contract(?:s|ed)?|close[sd]?\s+(?:above|below|over|under)|at least|at most)\b|(?:>|<)\s*\d/i;
const EXECUTION_LEVELS_RE = new RegExp(
  String.raw`entry\s*\$?(${PRICE_NUMBER}).*?stop\s*\$?(${PRICE_NUMBER}).*?target\s*\$?(${PRICE_NUMBER})`,
  "i",
);

function parseRules(brief: string): RuleEvidence[] {
  const header = RULES_HEADER_RE.exec(brief);
  if (!header || header.index === undefined) return [];

  const start = header.index + header[0].length;
  const rest = brief.slice(start);
  const nextSection = SECTION_HEADER_RE.exec(rest);
  const section = nextSection?.index === undefined ? rest : rest.slice(0, nextSection.index);
  const rules: RuleEvidence[] = [];

  for (const line of section.split(/\r?\n/)) {
    const idMatch = line.match(/\[(C\d+)\]/i);
    if (!idMatch) continue;
    const id = idMatch[1].toUpperCase();
    // Grounding rules are rendered as `[C1] ... "verbatim quote" — source`.
    // Retain the exact quoted text; do not normalize punctuation or spacing.
    const quoted = line.match(/"([^"]+)"|“([^”]+)”/);
    const text = quoted?.[1] ?? quoted?.[2] ?? "";
    if (text) rules.push({ id, text });
  }
  return rules;
}

function scoreGrounding(verdict: StructuredVerdict, brief: string): [CriterionScore, string] {
  const rules = parseRules(brief);
  const citedIds = [...verdict.because.matchAll(EVIDENCE_ID_RE)].map((match) => match[0].toUpperCase());
  if (rules.length === 0 || citedIds.length === 0) {
    return [0, "No cited evidence id could be matched to a quoted RULES entry."];
  }

  const citedRules = rules.filter((rule) => citedIds.includes(`[${rule.id}]`));
  if (citedRules.length === 0) return [0, "BECAUSE cites no id present in the brief's RULES section."];

  const quotes = [...verdict.because.matchAll(/\"([^\"]+)\"|“([^”]+)”/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  if (quotes.length === 0) {
    return [1, `${citedRules.map((rule) => rule.id).join(", ")} is valid, but BECAUSE contains no quoted evidence text.`];
  }
  if (citedRules.some((rule) => quotes.includes(rule.text))) {
    return [2, "A cited RULES id is present and its quoted text matches exactly."];
  }
  if (citedRules.some((rule) => quotes.some((quote) => rule.text.includes(quote) || quote.includes(rule.text)))) {
    return [1, "A cited RULES id is valid, but its quoted text is only a partial match."];
  }
  return [0, "The cited RULES id is valid, but the quoted text does not match it."];
}

function scoreFalsifiability(invalidation: string): [CriterionScore, string] {
  if (TRIGGERED_PRICE_RE.test(invalidation)) return [2, "INVALIDATION ties a concrete numeric level to a trigger."];
  if (NAMED_OBSERVABLE_RE.test(invalidation) && EXPLICIT_CONDITION_RE.test(invalidation)) {
    return [2, "INVALIDATION names an observable condition with an explicit trigger."];
  }
  if (NAMED_OBSERVABLE_RE.test(invalidation)) {
    return [1, "INVALIDATION names an observable, but its trigger is not concrete."];
  }
  return [0, "INVALIDATION has no concrete price level or named observable condition."];
}

function scoreConsistency(verdict: StructuredVerdict): [CriterionScore, string] {
  const direction = directionFromOutlook(verdict.outlook);
  const levels = verdict.execution.match(EXECUTION_LEVELS_RE);
  if (direction === "neutral" || !levels) {
    return [1, "Direction or ordered entry/stop/target levels are unavailable to this proxy."];
  }
  const [entry, stop, target] = levels.slice(1).map((value) => Number(value.replaceAll(",", "")));
  if (![entry, stop, target].every((value) => Number.isFinite(value) && value > 0)) {
    return [1, "EXECUTION levels could not be parsed reliably."];
  }
  const ordered = direction === "bullish" ? stop < entry && entry < target : target < entry && entry < stop;
  if (!ordered) return [0, `EXECUTION level ordering conflicts with the ${direction} OUTLOOK.`];
  return [2, `EXECUTION levels are ordered consistently with the ${direction} OUTLOOK.`];
}

function scoreSpecificity(verdict: StructuredVerdict): [CriterionScore, string] {
  const text = [verdict.outlook, verdict.because, verdict.invalidation, verdict.execution].join(" ");
  const hasPrice = PRICE_LEVEL_RE.test(text);
  const hasTimeframe = TIMEFRAME_RE.test(text);
  if (hasPrice && hasTimeframe) return [2, "Verdict includes a concrete numeric level and timeframe."];
  if (hasPrice || hasTimeframe) return [1, "Verdict includes a level or timeframe, but not both."];
  return [0, "Verdict has no numeric level or timeframe; it reads as generic commentary."];
}

function evidenceStrength(rules: RuleEvidence[], citedIds: string[]): number {
  return rules.filter((rule) => citedIds.includes(`[${rule.id}]`)).reduce((strength, rule) => {
    const hasRate = /\b\d+(?:\.\d+)?\s*%/.test(rule.text);
    const hasSample = /\b(?:n\s*=\s*\d+|\d+\s+(?:prior\s+)?occurrences?)\b/i.test(rule.text);
    return strength + (hasRate && hasSample ? 2 : hasRate || hasSample ? 1 : 0);
  }, 0);
}

function scoreCalibration(
  verdict: StructuredVerdict,
  brief: string,
  confidence?: DeclaredConfidence,
): [CriterionScore, string] {
  if (!confidence) return [0, "No declared confidence is available on StructuredVerdict."];

  const rules = parseRules(brief);
  const citedIds = [...verdict.because.matchAll(EVIDENCE_ID_RE)].map((match) => match[0].toUpperCase());
  const strength = evidenceStrength(rules, citedIds);
  const aligned =
    (confidence === "high" && strength >= 4) ||
    (confidence === "medium" && strength >= 1 && strength <= 3) ||
    (confidence === "low" && strength === 0);

  if (aligned) return [2, `${confidence} confidence aligns with the proxy evidence strength (${strength}).`];
  if ((confidence === "high" && strength >= 1) || (confidence === "medium" && strength === 0)) {
    return [1, `${confidence} confidence is only partly supported by the proxy evidence strength (${strength}).`];
  }
  return [0, `${confidence} confidence conflicts with the proxy evidence strength (${strength}).`];
}

/**
 * Score reasoning using deterministic, inspectable text proxies. `confidence`
 * is optional because the real `StructuredVerdict` contract currently has no
 * confidence field; callers with separate declared-confidence metadata may
 * pass it explicitly. Missing confidence is scored 0, never guessed.
 */
export function simulateJudge(
  verdict: StructuredVerdict,
  brief: string,
  confidence?: DeclaredConfidence,
): SimulatedJudgeResult {
  const criteria: Record<Criterion, [CriterionScore, string]> = {
    grounding: scoreGrounding(verdict, brief),
    falsifiability: scoreFalsifiability(verdict.invalidation),
    consistency: scoreConsistency(verdict),
    specificity: scoreSpecificity(verdict),
    calibration: scoreCalibration(verdict, brief, confidence),
  };
  const scores: JudgeResult["scores"] = {
    grounding: criteria.grounding[0],
    falsifiability: criteria.falsifiability[0],
    consistency: criteria.consistency[0],
    specificity: criteria.specificity[0],
    calibration: criteria.calibration[0],
  };
  const justifications: JudgeResult["justifications"] = {
    grounding: criteria.grounding[1],
    falsifiability: criteria.falsifiability[1],
    consistency: criteria.consistency[1],
    specificity: criteria.specificity[1],
    calibration: criteria.calibration[1],
  };
  const total = Object.values(scores).reduce((sum, score) => sum + score, 0);

  return {
    label: JUDGE_SIM_LABEL,
    version: JUDGE_SIM_VERSION,
    scores,
    total,
    justifications,
  };
}
