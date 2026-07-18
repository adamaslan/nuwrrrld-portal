/**
 * Structured council verdict — parsing + validation for the T1/T2 quick-ask
 * flow (/api/council, used by the Hold/Fold ticker detail panel) and the
 * 6-seat deliberation (/api/council/deliberate).
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
 * validates the required fields before a caller renders anything.
 *
 * Format (docs/council-prompting-small-models.md §2-3): 4 fields instead of
 * 6 — a 7B model drops directives past the third or fourth, and BECAUSE
 * folds evidence-id + quote into one copyable slot instead of composing a
 * free-text "key driver" sentence. EXECUTION bundles entry/stop/target into
 * one line for the same reason.
 */

export interface StructuredVerdict {
  outlook: string;
  because: string;
  invalidation: string;
  execution: string;
}

const FIELD_DEFS: Array<{ key: keyof StructuredVerdict; label: string }> = [
  { key: "outlook", label: "OUTLOOK" },
  { key: "because", label: "BECAUSE" },
  { key: "invalidation", label: "INVALIDATION" },
  { key: "execution", label: "EXECUTION" },
];

/**
 * Strip chain-of-thought some models emit despite instructions not to:
 * explicit <think>/[thinking] blocks, and any prose preceding the first
 * recognized field label.
 */
export function stripReasoning(raw: string): string {
  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\[thinking\][\s\S]*?\[\/thinking\]/gi, "")
    .replace(/\*/g, "");

  const firstLabel = cleaned.match(/OUTLOOK\s*:/i);
  if (firstLabel && firstLabel.index !== undefined && firstLabel.index > 0) {
    cleaned = cleaned.slice(firstLabel.index);
  }
  return cleaned.trim();
}

const VALID_OUTLOOKS = new Set(["bullish", "bearish", "neutral"]);

/**
 * Parse the four required fields out of a cleaned response. Returns null if
 * any field is missing, or if OUTLOOK isn't exactly one of the three enum
 * values — callers should retry once or show a fallback error state rather
 * than render a partial/raw answer. (An arbitrary OUTLOOK string used to
 * pass through silently and fall back to "neutral" in directionFromOutlook;
 * flagged in PR #34 review — that's now a parse failure, not a silent guess.)
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
  if (!complete) return null;
  if (!VALID_OUTLOOKS.has(values.outlook!.toLowerCase())) return null;
  return values as StructuredVerdict;
}

/** Normalize a free-text outlook into the direction enum the verdict ledger uses. */
export function directionFromOutlook(outlook: string): "bullish" | "bearish" | "neutral" {
  const o = outlook.toLowerCase();
  if (o.includes("bull")) return "bullish";
  if (o.includes("bear")) return "bearish";
  return "neutral";
}

export const STRUCTURED_VERDICT_INSTRUCTIONS = [
  "Respond with ONLY the following four labeled fields, in this exact order, one per line.",
  "Do not include any reasoning, planning, preamble, or commentary before, between, or after them —",
  "output must start immediately with \"OUTLOOK:\" and contain nothing else.",
  "OUTLOOK: bullish, bearish, or neutral",
  "BECAUSE: [id] says \"quote\" — an evidence id from RULES and its exact quote, copied not composed",
  "INVALIDATION: the exact price/level or condition that would void this call",
  "EXECUTION: entry X / stop Y / target Z, each a price or condition",
  "Every field must use only ids and numbers that appear in DATA or RULES above.",
].join("\n");
