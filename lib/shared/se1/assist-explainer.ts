/**
 * se1/assist-explainer — X26-04 honest neutral explainer. Pure logic; no I/O, no model call.
 *
 * Explains why a scan card has no result, in plain words. The state is computed here from catalog facts, never
 * from the caller. A model may rephrase the explanation, but its answer is kept only if every check in
 * validateAssistAnswer passes. Otherwise the deterministic text is shown.
 */
import { BUILT_FEEDS, FEED_LABEL, type ScanCard } from "../se1-catalog";

/** S26-05 state contract. Only the first two are reachable today: no results store is wired yet. */
export type AssistState = "absent_run" | "unsupported_feed" | "no_hit" | "not_computed" | "failed";

export interface AssistFacts {
  title: string;
  evidence_level: string;
  version: string;
  feed: string;
  feed_label: string;
  min_bars: number | null;
  state: AssistState;
}

/** The state of a card, computed from catalog facts alone. */
export function assistStateFor(card: ScanCard): AssistState {
  return BUILT_FEEDS.includes(card.feed) ? "absent_run" : "unsupported_feed";
}

export function assistFactsFor(card: ScanCard): AssistFacts {
  return {
    title: card.title,
    evidence_level: card.evidence_level,
    version: card.version,
    feed: card.feed,
    feed_label: FEED_LABEL[card.feed],
    min_bars: card.min_bars ?? null,
    state: assistStateFor(card),
  };
}

/** Deterministic text for each state. Always available, always shown when the model is skipped or rejected. */
export function deterministicExplanation(f: AssistFacts): string {
  if (f.state === "unsupported_feed") {
    return `${f.title} cannot run yet. It needs ${f.feed_label}, and this app does not have that feed. There is no result to read.`;
  }
  return `${f.title} has no recorded run, so there is no result to read. It is a ${f.evidence_level} spec: nothing has been run.`;
}

/** Prompt for the model. Built only from facts; the caller cannot add text. */
export function buildAssistPrompt(f: AssistFacts): string {
  const lines = [
    `title: ${f.title}`,
    `state: ${f.state}`,
    `evidence_level: ${f.evidence_level}`,
    `version: ${f.version}`,
    `feed: ${f.feed_label}`,
    ...(f.min_bars === null ? [] : [`min_bars: ${f.min_bars}`]),
  ];
  return [
    "Explain to a reader, in at most 60 words, why this scan card has no result.",
    "Use only the facts below. Do not give an investment opinion. Do not name any evidence level other than the one given.",
    "",
    ...lines,
  ].join("\n");
}

export const MAX_ASSIST_WORDS = 80;
const OPINION = /\b(buy|sell|bullish|bearish|long|short|target|recommend\w*)\b/i;
const NUMBER = /\d+(?:\.\d+)?/g;
const EVIDENCE = /\bE[0-4]\b/g;

export type AssistCheck = { ok: true } | { ok: false; reason: string };

/**
 * Keep a model answer only if it is non-empty, short, grounded in the facts, free of opinion words, and names
 * no evidence level above the card's own. Every failure is a reason, never a silent pass.
 */
export function validateAssistAnswer(answer: string, f: AssistFacts): AssistCheck {
  const text = answer.trim();
  if (text === "") return { ok: false, reason: "empty answer" };
  if (text.split(/\s+/).length > MAX_ASSIST_WORDS) return { ok: false, reason: "answer too long" };
  if (OPINION.test(text)) return { ok: false, reason: "opinion wording" };

  const factText = [f.title, f.evidence_level, f.version, f.feed_label, f.min_bars === null ? "" : String(f.min_bars)].join(" ");
  const allowedNumbers = new Set(factText.match(NUMBER) ?? []);
  for (const n of text.match(NUMBER) ?? []) {
    if (!allowedNumbers.has(n)) return { ok: false, reason: `number not in facts: ${n}` };
  }
  for (const level of text.match(EVIDENCE) ?? []) {
    if (level !== f.evidence_level) return { ok: false, reason: `evidence level not in facts: ${level}` };
  }
  return { ok: true };
}
