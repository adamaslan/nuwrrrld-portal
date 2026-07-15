/**
 * Structured council verdict — parsing + validation for the T1/T2 quick-ask
 * flow (/api/council, used by the Hold/Fold ticker detail panel).
 *
 * Audit 2026-07-15 finding: the T1 card was rendering the model's raw
 * chain-of-thought ("The user wants a 1-5 day trade framing... I need to
 * extract specific numbers...") instead of a verdict, and truncating
 * mid-sentence. Root cause: the prompt asked for prose, not a delimited
 * format, so there was nothing to validate against and nothing to strip.
 *
 * Fix: seat prompts (lib/openrouter.ts SEAT_SYSTEM) now require an exact
 * `LABEL: value` block with no other text. This module strips any stray
 * reasoning a model still emits despite that instruction, then parses and
 * validates the six required fields before a caller renders anything.
 */

export interface StructuredVerdict {
  outlook: string;
  keyDriver: string;
  invalidationLevel: string;
  entry: string;
  exit: string;
  stop: string;
}

const FIELD_DEFS: Array<{ key: keyof StructuredVerdict; label: string }> = [
  { key: "outlook", label: "OUTLOOK" },
  { key: "keyDriver", label: "KEY_DRIVER" },
  { key: "invalidationLevel", label: "INVALIDATION_LEVEL" },
  { key: "entry", label: "ENTRY" },
  { key: "exit", label: "EXIT" },
  { key: "stop", label: "STOP" },
];

/**
 * Strip chain-of-thought some models emit despite instructions not to:
 * explicit <think>/[thinking] blocks, and any prose preceding the first
 * recognized field label.
 */
export function stripReasoning(raw: string): string {
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\[thinking\][\s\S]*?\[\/thinking\]/gi, "");

  const firstLabel = cleaned.match(/OUTLOOK\s*:/i);
  if (firstLabel && firstLabel.index !== undefined && firstLabel.index > 0) {
    cleaned = cleaned.slice(firstLabel.index);
  }
  return cleaned.trim();
}

/**
 * Parse the six required fields out of a cleaned response. Returns null if
 * any field is missing — callers should retry once or show a fallback error
 * state rather than render a partial/raw answer.
 */
export function parseStructuredVerdict(raw: string): StructuredVerdict | null {
  const cleaned = stripReasoning(raw);
  const values: Partial<Record<keyof StructuredVerdict, string>> = {};

  for (let i = 0; i < FIELD_DEFS.length; i++) {
    const { key, label } = FIELD_DEFS[i];
    const nextLabels = FIELD_DEFS.slice(i + 1).map((f) => f.label).join("|");
    const stopPattern = nextLabels ? `(?:${nextLabels})\\s*:|$` : "$";
    const re = new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=\\s*(?:${stopPattern}))`, "i");
    const match = cleaned.match(re);
    const value = match?.[1]?.trim();
    if (value) values[key] = value;
  }

  const complete = FIELD_DEFS.every((f) => Boolean(values[f.key]));
  return complete ? (values as StructuredVerdict) : null;
}

/** Normalize a free-text outlook into the direction enum the verdict ledger uses. */
export function directionFromOutlook(outlook: string): "bullish" | "bearish" | "neutral" {
  const o = outlook.toLowerCase();
  if (o.includes("bull")) return "bullish";
  if (o.includes("bear")) return "bearish";
  return "neutral";
}

export const STRUCTURED_VERDICT_INSTRUCTIONS = [
  "Respond with ONLY the following six labeled fields, in this exact order, one per line.",
  "Do not include any reasoning, planning, preamble, or commentary before, between, or after them —",
  "output must start immediately with \"OUTLOOK:\" and contain nothing else.",
  "OUTLOOK: bullish, bearish, or neutral",
  "KEY_DRIVER: the single strongest data-backed reason (one sentence)",
  "INVALIDATION_LEVEL: the exact price/level or condition that would void this call",
  "ENTRY: entry price or condition",
  "EXIT: target price or condition",
  "STOP: stop-loss price or condition",
].join("\n");
