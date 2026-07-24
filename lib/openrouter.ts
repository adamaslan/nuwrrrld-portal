/**
 * OpenRouter client — multi-model AI council seats.
 *
 * Six roles (WS2, portal-10x-council-db-local.md):
 *   T1    = short-term trader (fast, tactical)
 *   T2    = long-term investor (strategic)
 *   RISK  = devil's advocate — argues against the trade, sizes the downside
 *   MACRO = rates / dollar / sector-rotation context
 *   QUANT = interprets the provided data ONLY (score, hit-rates) — no narrative
 *   CHAIR = reads all seats, issues the synthesis + structured verdict
 */

import { STRUCTURED_VERDICT_INSTRUCTIONS } from './council-verdict';

export type CouncilSeat = 'T1' | 'T2' | 'RISK' | 'MACRO' | 'QUANT' | 'CHAIR';

/** The debate seats (everyone except the synthesizing chair). */
export const DEBATE_SEATS: CouncilSeat[] = ['T1', 'T2', 'RISK', 'MACRO', 'QUANT'];

export interface CouncilMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CouncilResponse {
  answer: string;
  model: string;
  seat: CouncilSeat;
  latencyMs: number;
}

const OR_BASE = 'https://openrouter.ai/api/v1';

// Free-tier model fallback chain — tried in order on 402 / 429 / 5xx.
// Every entry must be truly free-tier (:free suffix, confirmed $0 quota).
// Maintained by scripts/refresh-free-models.mjs (weekly GitHub Action).
export const FREE_MODEL_CHAIN = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
] as const;

// Seat primary models; falls back through FREE_MODEL_CHAIN on failure. All
// free-tier to keep deliberation (~11 calls) at $0 — see WS2.6 cost control.
const SEAT_MODELS: Record<CouncilSeat, string> = {
  T1: 'cohere/command-r7b-12-2024',
  T2: 'qwen/qwen3-next-80b-a3b-instruct:free',
  RISK: 'meta-llama/llama-3.3-70b-instruct:free',
  MACRO: 'qwen/qwen3-next-80b-a3b-instruct:free',
  QUANT: 'mistralai/mistral-7b-instruct:free',
  CHAIR: 'qwen/qwen3-next-80b-a3b-instruct:free',
};

// Seat-to-model assignment (docs/council-prompting-small-models.md §10):
// spend the best free model on the one irreducibly hard job (CHAIR
// synthesis) and the smallest on tasks reduced to pure classification (CHAIR
// verdict, run 3x). QUANT already carries the smallest model in the chain.
export const SMALLEST_MODEL = SEAT_MODELS.QUANT;

// Prompt contract (docs/council-prompting-small-models.md): ≤5 directives per
// call, checklist over prose, positive constraints only (small models handle
// "do X" far better than "don't do Y"), and the critical constraint repeated
// last — recency wins in small models. Every fallback model in
// FREE_MODEL_CHAIN is a 7B-30B class model, so these prompts are written for
// the worst model in the chain, not the best.
const _DISCLAIMER = 'You provide informational analysis only — not personalised financial advice.';
const _GROUND = 'Ground every claim in DATA. If RULES are listed, pick 2-3 that apply — never invent evidence.';

const SEAT_SYSTEM: Record<CouncilSeat, string> = {
  T1: [
    'You are T1, the short-term trader (1-60 days) for NuWrrrld Financial.',
    _GROUND,
    _DISCLAIMER,
    STRUCTURED_VERDICT_INSTRUCTIONS,
  ].join(' '),
  T2: [
    'You are T2, the long-term investor (2 months-5 years) for NuWrrrld Financial.',
    // 3-12 months matches the "3-12m" horizon persisted in app/api/council/route.ts —
    // keep this in sync with that literal (flagged as an inconsistency in PR #34 review).
    'OUTLOOK is the secular thesis direction; EXECUTION covers a 3-12 month entry range, target, and downside stop.',
    _GROUND,
    _DISCLAIMER,
    STRUCTURED_VERDICT_INSTRUCTIONS,
  ].join(' '),
  RISK: [
    'You are RISK, the devil\'s advocate for NuWrrrld Financial.',
    'Argue the case AGAINST the prevailing direction: name the failure mode, the downside scenario,',
    'and a position size that survives being wrong.',
    'If RULES are listed, they already oppose the majority — cite 1-2 by id instead of inventing dissent.',
    _GROUND,
    `Be concise (~150 words); stay in the bear/bull opposite case. ${_DISCLAIMER}`,
  ].join(' '),
  MACRO: [
    'You are MACRO for NuWrrrld Financial.',
    'Frame the setup in rates, the dollar, liquidity, and sector rotation — state whether the macro wind',
    'favors or opposes this trade, and the macro event that would invalidate it.',
    'If RULES are listed, cite the ones that apply by id.',
    _GROUND,
    `Be concise (~150 words). ${_DISCLAIMER}`,
  ].join(' '),
  QUANT: [
    'You are QUANT for NuWrrrld Financial.',
    'Interpret only the numeric DATA: confluence score, per-indicator signals, historical hit-rates.',
    'State plainly what the numbers support; say so plainly when the data is thin.',
    'Use numbers only, no outside knowledge and no prose rules.',
    `Be concise (~130 words). ${_DISCLAIMER}`,
  ].join(' '),
  // Synthesis only — prose, no JSON. The verdict is a separate, tiny call
  // (see CHAIR_VERDICT_SYSTEM) so a malformed JSON line can never corrupt
  // the synthesis and vice versa (docs/council-prompting-small-models.md §6).
  CHAIR: [
    'You are the Chair of the NuWrrrld Financial AI Council.',
    'Read every seat\'s answer and critique, then synthesize: state whether the council is in',
    'consensus or split, and the strongest argument on each side.',
    _GROUND,
    `Prose only, ~180 words — no JSON, no verdict line. ${_DISCLAIMER}`,
  ].join(' '),
};

/**
 * The CHAIR's second call: verdict only, nothing else. Kept separate from
 * synthesis so it can run at max_tokens≈80 and be JSON.parse'd directly —
 * no regex fishing through prose for a stray `{...}` line.
 */
export const CHAIR_VERDICT_SYSTEM = [
  'Output ONLY a single-line JSON object matching this schema, nothing else:',
  '{"direction":"bullish|bearish|neutral","confidence":"low|medium|high","horizon":"e.g. 1-5d","invalidation":"the level/condition that voids the call"}',
  'No prose, no markdown, no explanation. Output must start with { and end with }.',
].join(' ');

/**
 * Try each model in FREE_MODEL_CHAIN until one returns 2xx.
 * Retries on 402 / 429 / 5xx; other errors propagate immediately.
 * Callers provide baseBody WITHOUT the model field.
 */
export async function fetchWithModelFallback(
  apiKey: string,
  baseBody: Record<string, unknown>,
  appTitle: string,
  signal?: AbortSignal,
): Promise<{ response: Response; model: string }> {
  let lastStatus = 503;
  for (const model of FREE_MODEL_CHAIN) {
    try {
      const response = await fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://financial.nuwrrrld.com',
          'X-Title': appTitle,
        },
        body: JSON.stringify({ ...baseBody, model }),
      });
      if (response.ok) return { response, model };
      lastStatus = response.status;
      await response.body?.cancel().catch(() => {});
      // Retry on 402 (free-tier quota) / 429 (rate limit) / 5xx; other 4xx are
      // fatal for this request and propagate. 402 must fall through so one
      // exhausted free model doesn't abort the rest of the chain.
      if (response.status !== 402 && response.status !== 429 && response.status < 500) break;
    } catch (err) {
      // Re-throw client-initiated aborts; treat network errors as transient and try next model.
      if (err instanceof Error && err.name === 'AbortError') throw err;
    }
  }
  throw new Error(`OpenRouter ${lastStatus}: all models in chain failed`);
}

/**
 * Run one seat against an explicit message list, trying the seat's primary model
 * then the free-tier chain. Returns the answer plus which model served it and the
 * wall-clock latency (persisted for observability). Throws only if every model
 * in the chain fails — callers isolate per-seat failures.
 */
export async function runSeat(
  seat: CouncilSeat,
  messages: CouncilMessage[],
  apiKey: string,
  maxTokens = 500,
  temperature = 0.4,
  modelOverride?: string,
): Promise<CouncilResponse> {
  const primaryModel = modelOverride ?? SEAT_MODELS[seat];
  const modelChain = [primaryModel, ...FREE_MODEL_CHAIN.filter(m => m !== primaryModel)];

  const started = Date.now();
  let lastStatus = 503;
  for (const model of modelChain) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://financial.nuwrrrld.com',
          'X-Title': 'NuWrrrld Financial AI Council',
        },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      });
      if (res.ok) {
        const data = await res.json();
        const answer = data.choices?.[0]?.message?.content ?? '';
        return { answer, model, seat, latencyMs: Date.now() - started };
      }
      lastStatus = res.status;
      await res.body?.cancel().catch(() => {});
      // Retry on 402 (free-tier quota) / 429 (rate limit) / 5xx; other 4xx are
      // fatal for this request and propagate.
      if (res.status !== 402 && res.status !== 429 && res.status < 500) break;
    } catch (err) {
      // Timeout (AbortError from our own ctrl) → try next model; other errors propagate.
      if (err instanceof Error && err.name !== 'AbortError') throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`OpenRouter ${lastStatus}: council ${seat} — all models failed`);
}

/** System prompt for a seat — exported so the deliberation route can compose rounds. */
export function seatSystemPrompt(seat: CouncilSeat): string {
  return SEAT_SYSTEM[seat];
}

/** Backwards-compatible single-shot call used by the existing /api/council route. */
export async function callCouncilSeat(
  seat: CouncilSeat,
  userPrompt: string,
  apiKey: string,
  maxTokens = 500,
): Promise<CouncilResponse> {
  return runSeat(
    seat,
    [
      { role: 'system', content: SEAT_SYSTEM[seat] },
      { role: 'user', content: userPrompt },
    ],
    apiKey,
    maxTokens,
  );
}
