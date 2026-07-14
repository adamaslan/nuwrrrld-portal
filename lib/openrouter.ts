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
  'openai/gpt-oss-120b:free',
  'google/gemma-4-31b-it:free',
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

const _DISCLAIMER = 'You provide informational analysis only — not personalised financial advice.';
const _GROUND = 'Ground every claim in the exact data provided. Cite specific numbers.';

const SEAT_SYSTEM: Record<CouncilSeat, string> = {
  T1: [
    'You are the Short-Term Trading Council seat (T1) for NuWrrrld Financial.',
    'You analyze tactical trades across 1-day to 60-day horizons.',
    _GROUND,
    'Deliver: outlook (bullish/bearish/neutral), key driver, invalidation level, entry/exit/stop.',
    'Be concise (~150 words). No generic platitudes.',
    _DISCLAIMER,
  ].join(' '),
  T2: [
    'You are the Long-Term Investment Council seat (T2) for NuWrrrld Financial.',
    'You analyze strategic positions across 2-month to 5-year horizons.',
    _GROUND,
    'Deliver: secular thesis, risk/reward over 6-12m, key catalyst and invalidation.',
    'Be concise (~150 words). No generic platitudes.',
    _DISCLAIMER,
  ].join(' '),
  RISK: [
    'You are the Risk Council seat (RISK) for NuWrrrld Financial — the devil\'s advocate.',
    'Argue the case AGAINST the prevailing direction. Name the specific failure modes,',
    'the downside scenario, and how a position would be sized to survive being wrong.',
    _GROUND,
    'Be concise (~150 words). Do not hedge into neutrality — your job is the bear/bull opposite case.',
    _DISCLAIMER,
  ].join(' '),
  MACRO: [
    'You are the Macro Council seat (MACRO) for NuWrrrld Financial.',
    'Frame the setup in rates, the dollar, liquidity, and sector rotation. Is the macro',
    'wind at this trade\'s back or in its face? What macro event would invalidate it?',
    _GROUND,
    'Be concise (~150 words).',
    _DISCLAIMER,
  ].join(' '),
  QUANT: [
    'You are the Quant Council seat (QUANT) for NuWrrrld Financial.',
    'Interpret ONLY the numeric data in the brief: confluence score, per-indicator',
    'signals, and historical hit-rates. State what the numbers support, with no',
    'narrative or outside knowledge. If the data is thin, say so plainly.',
    'Be concise (~130 words).',
    _DISCLAIMER,
  ].join(' '),
  CHAIR: [
    'You are the Chair of the NuWrrrld Financial AI Council.',
    'You have read every seat\'s answer and critique. Synthesize: state whether the',
    'council is in consensus or split, the strongest argument on each side, and your',
    'call. Then, on the FINAL line, output a single-line JSON verdict:',
    '{"direction":"bullish|bearish|neutral","confidence":"low|medium|high","horizon":"e.g. 1-5d","invalidation":"the level/condition that voids the call"}',
    _GROUND,
    'Prose ~180 words, then the JSON line.',
    _DISCLAIMER,
  ].join(' '),
};

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
): Promise<CouncilResponse> {
  const primaryModel = SEAT_MODELS[seat];
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
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4 }),
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
): Promise<CouncilResponse> {
  return runSeat(
    seat,
    [
      { role: 'system', content: SEAT_SYSTEM[seat] },
      { role: 'user', content: userPrompt },
    ],
    apiKey,
    400,
  );
}
