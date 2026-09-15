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

/** Per-attempt call budget (§4.2 step 6: "max_tokens≈80"). Temperature 0.2 —
 *  this is a judgment call on one already-sized trade, not a debate seat's
 *  open-ended prose, so it should be closer to deterministic than SEAT_SYSTEM's
 *  default 0.4. */
const ARBITRATION_MAX_TOKENS = 80;
const ARBITRATION_TEMPERATURE = 0.2;

export const ARBITRATION_SYSTEM = [
  "You are judging ONE already-sized proposed trade. You may not choose a different",
  "ticker, change direction, or invent a size.",
  'Output ONLY a single-line JSON object matching this schema, nothing else:',
  '{"action":"veto|downsize|confirm","downsize_pct":0.0}',
  '"downsize_pct" is required only when action is "downsize" (a number strictly',
  "between 0 and 1 — the fraction to cut). Omit it for veto or confirm.",
  "No prose, no markdown, no explanation. Output must start with { and end with }.",
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
  ].join(" ");
}

/**
 * Unparseable/malformed model output = CONFIRM-none (§4.2 step 6) — the
 * order proceeds exactly as RANK/PROPOSE/CLIP sized it. A hallucinated or
 * broken response can therefore never do more than "a trade that didn't
 * happen" (a veto) or "a trade sized exactly as the deterministic layer
 * already decided" (a no-op confirm) — guardrail #5.
 */
export function parseArbitrationResponse(raw: string): { action: "veto" | "downsize" | "confirm"; downsizePct?: number } {
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.action === "veto" || parsed.action === "confirm") {
      return { action: parsed.action };
    }
    if (parsed.action === "downsize") {
      const pct = Number(parsed.downsize_pct);
      if (Number.isFinite(pct) && pct > 0 && pct < 1) {
        return { action: "downsize", downsizePct: pct };
      }
    }
  } catch {
    // Not JSON at all — fall through to CONFIRM-none below.
  }
  return { action: "confirm" };
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
  const parsed = parseArbitrationResponse(response.answer);
  return { ticker: candidate.order.ticker, ...parsed, model: response.model };
}
