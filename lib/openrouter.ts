/**
 * OpenRouter client — multi-model AI council seats.
 * T1 = short-term trader (fast, tactical)
 * T2 = long-term investor (deeper, strategic)
 */

export type CouncilSeat = 'T1' | 'T2';

export interface CouncilMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CouncilResponse {
  answer: string;
  model: string;
  seat: CouncilSeat;
}

const OR_BASE = 'https://openrouter.ai/api/v1';

// Free-tier model fallback chain — tried in order on 429 / 5xx.
export const FREE_MODEL_CHAIN = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'cohere/command-r7b-12-2024',
  'mistralai/mistral-7b-instruct:free',
] as const;

// Seat primary models; falls back through FREE_MODEL_CHAIN on failure.
const SEAT_MODELS: Record<CouncilSeat, string> = {
  T1: 'cohere/command-r7b-12-2024',
  T2: 'qwen/qwen3-next-80b-a3b-instruct:free',
};

const SEAT_SYSTEM: Record<CouncilSeat, string> = {
  T1: [
    'You are the Short-Term Trading Council seat (T1) for NuWrrrld Financial.',
    'You analyze tactical trades across 1-day to 60-day horizons.',
    'Ground every claim in the exact data provided. Cite specific numbers.',
    'Deliver: outlook (bullish/bearish/neutral), key driver, invalidation level, entry/exit/stop.',
    'Be concise (~180 words). No generic platitudes.',
    'You provide informational analysis only — not personalised financial advice.',
  ].join(' '),
  T2: [
    'You are the Long-Term Investment Council seat (T2) for NuWrrrld Financial.',
    'You analyze strategic positions across 2-month to 5-year horizons.',
    'Ground every claim in the exact data provided. Cite specific numbers.',
    'Deliver: secular thesis, risk/reward over 6-12m, key catalyst and invalidation.',
    'Be concise (~180 words). No generic platitudes.',
    'You provide informational analysis only — not personalised financial advice.',
  ].join(' '),
};

/**
 * Try each model in FREE_MODEL_CHAIN until one returns 2xx.
 * Retries on 429 / 5xx only; other errors propagate immediately.
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
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(`OpenRouter ${lastStatus}: all models in chain failed`);
}

export async function callCouncilSeat(
  seat: CouncilSeat,
  userPrompt: string,
  apiKey: string,
): Promise<CouncilResponse> {
  const primaryModel = SEAT_MODELS[seat];
  const modelChain = [primaryModel, ...FREE_MODEL_CHAIN.filter(m => m !== primaryModel)];

  let lastStatus = 503;
  for (const model of modelChain) {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://financial.nuwrrrld.com',
        'X-Title': 'NuWrrrld Financial AI Council',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SEAT_SYSTEM[seat] },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 400,
        temperature: 0.4,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const answer = data.choices?.[0]?.message?.content ?? '';
      return { answer, model, seat };
    }
    lastStatus = res.status;
    await res.body?.cancel().catch(() => {});
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(`OpenRouter ${lastStatus}: council ${seat} — all models failed`);
}
