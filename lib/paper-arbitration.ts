/**
 * paper-arbitration — the model side of ARBITRATE (§4.2 step 6, Phase 5 of
 * docs/paper-portfolios-remaining-todo.md).
 *
 * `lib/shared/paper-engine-core.ts` decides *which* proposed orders qualify
 * for arbitration (pure). This module makes the actual model call for one
 * candidate and parses its answer. It is deliberately thin: one call in, one
 * `ArbitrationResult` out, never throws (a failed/unparseable call degrades
 * to CONFIRM-none per §4.2 step 6 — see `parseArbitrationResponse`).
 *
 * Uses the seat's own persona system prompt (`seatSystemPrompt`) with the
 * constrained-output instructions below appended, the same "prose call, then
 * a tiny structured call" split CHAIR_VERDICT_SYSTEM already uses — except
 * here there is no prose call at all, just the structured one, since the
 * model's only job is VETO/DOWNSIZE/CONFIRM on a trade it did not choose.
 */
import { runSeat, seatSystemPrompt, type CouncilSeat } from "@/lib/openrouter";
import type { ArbitrationCandidate, ArbitrationResult } from "@/lib/shared/paper-engine-core";

/** Per-attempt call budget. Matches runSeat's own 1200 default: at 160 (which
 *  replaced 80 for the one-line `why`, docs/paper-trading-v3.md §4.2/F8)
 *  reasoning models spent the whole budget on hidden thinking and returned an
 *  empty completion, or leaked chain-of-thought cut off mid-sentence that
 *  could not be parsed (2026-10-13 live probe). Temperature 0.2 — this is a judgment call on one
 *  already-sized trade, not a debate seat's open-ended prose, so it should be
 *  closer to deterministic than SEAT_SYSTEM's default 0.4. */
const ARBITRATION_MAX_TOKENS = 1200;
const ARBITRATION_TEMPERATURE = 0.2;

export const ARBITRATION_SYSTEM = [
  "You are judging ONE already-sized proposed trade. You may not choose a different",
  "ticker, change direction, or invent a size.",
  'Output ONLY a single-line JSON object matching this schema, nothing else:',
  '{"action":"veto|downsize|confirm","downsize_pct":0.0,"why":"<=25 words"}',
  '"downsize_pct" is required only when action is "downsize" (a number strictly',
  "between 0 and 1 — the fraction to cut). Omit it for veto or confirm.",
  '"why" is required for every action — one short sentence, in your own voice,',
  "citing only facts given in this prompt (never invent a number not shown here).",
  "No prose beyond that field, no markdown. Output must start with { and end with }.",
].join(" ");

function buildUserPrompt(candidate: ArbitrationCandidate, nav: number): string {
  const { order, flagReason } = candidate;
  const notional = order.quantity * order.refPrice;
  const navPct = nav > 0 ? (notional / nav) * 100 : 0;
  const flagLine =
    flagReason === "score_tie"
      ? "FLAG: this entry's card score is close to the buy threshold — a toss-up, not a clear signal."
      : "FLAG: this exit is signal-driven (not a hard stop) and the position is trading close to its stop level.";
  return [
    `PROPOSED TRADE: ${order.side.toUpperCase()} ${order.ticker}, ~${navPct.toFixed(1)}% of NAV,`,
    `reference price $${order.refPrice.toFixed(2)}, reason=${order.reason}.`,
    flagLine,
    "VETO to skip this trade entirely, DOWNSIZE to cut its size, or CONFIRM to let it proceed as sized.",
    'Include "why" — a short, plain reason grounded only in the facts above.',
  ].join(" ");
}

/**
 * Unparseable/malformed model output = CONFIRM-none (§4.2 step 6) — the
 * order proceeds exactly as RANK/PROPOSE/CLIP sized it. A hallucinated or
 * broken response can therefore never do more than "a trade that didn't
 * happen" (a veto) or "a trade sized exactly as the deterministic layer
 * already decided" (a no-op confirm) — guardrail #5.
 */
/** 25 words is the prompt's own ask; truncated defensively rather than
 *  trusted, since a model can ignore a length instruction. */
const WHY_MAX_CHARS = 240;

function extractWhy(parsed: Record<string, unknown>): string | undefined {
  const why = parsed.why;
  return typeof why === "string" && why.trim().length > 0 ? why.trim().slice(0, WHY_MAX_CHARS) : undefined;
}

type ParsedArbitration = { action: "veto" | "downsize" | "confirm"; downsizePct?: number; why?: string };

function interpretArbitration(parsed: unknown): ParsedArbitration | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.action === "veto" || obj.action === "confirm") {
    return { action: obj.action, why: extractWhy(obj) };
  }
  if (obj.action === "downsize") {
    const pct = Number(obj.downsize_pct);
    if (Number.isFinite(pct) && pct > 0 && pct < 1) {
      return { action: "downsize", downsizePct: pct, why: extractWhy(obj) };
    }
  }
  return null;
}

/** Every top-level balanced `{...}` substring that mentions "action", in order.
 *  Reasoning models often emit prose and then the JSON; the last object wins. */
function balancedObjectsWithAction(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && text.slice(start, i + 1).includes('"action"')) found.push(text.slice(start, i + 1));
    }
  }
  return found;
}

/** Returns the decision, or null when nothing in `raw` parses to a valid one. */
export function tryParseArbitrationResponse(raw: string): ParsedArbitration | null {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  try {
    const direct = interpretArbitration(JSON.parse(text));
    if (direct) return direct;
  } catch {
    // Prose around the JSON — fall through to substring extraction.
  }
  const candidates = balancedObjectsWithAction(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const result = interpretArbitration(JSON.parse(candidates[i]));
      if (result) return result;
    } catch {
      // Malformed candidate — try the previous one.
    }
  }
  return null;
}

export function parseArbitrationResponse(raw: string): ParsedArbitration {
  // Unparseable/malformed = CONFIRM-none per the module doc; `why` is
  // deliberately absent here (not a placeholder string) so a caller can tell
  // "the model explained itself" apart from "the model's output was unusable".
  return tryParseArbitrationResponse(raw) ?? { action: "confirm" };
}

/**
 * Run one arbitration call. Throws only on a transport-level failure (every
 * model in the chain failed) — callers isolate per-candidate failures the
 * same way `runAccountSlot` isolates per-account ones, so one bad call
 * degrades the run to fewer arbitrated candidates rather than failing it.
 */
export async function arbitrateOne(
  seat: CouncilSeat,
  candidate: ArbitrationCandidate,
  nav: number,
  apiKey: string,
): Promise<ArbitrationResult> {
  const messages = [
    { role: "system" as const, content: `${seatSystemPrompt(seat)} ${ARBITRATION_SYSTEM}` },
    { role: "user" as const, content: buildUserPrompt(candidate, nav) },
  ];
  const response = await runSeat(seat, messages, apiKey, ARBITRATION_MAX_TOKENS, ARBITRATION_TEMPERATURE);
  const decision = tryParseArbitrationResponse(response.answer);
  const parsed = decision ?? { action: "confirm" as const };
  return {
    ticker: candidate.order.ticker,
    ...parsed,
    model: response.model,
    why: parsed.why,
    parsed: decision !== null,
  };
}
