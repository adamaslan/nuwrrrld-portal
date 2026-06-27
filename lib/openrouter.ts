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

// Seat → model mapping. Prefer fast/cheap for T1, stronger for T2.
const SEAT_MODELS: Record<CouncilSeat, string> = {
  T1: 'meta-llama/llama-3.3-70b-instruct',
  T2: 'openai/gpt-4o-mini',
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

export async function callCouncilSeat(
  seat: CouncilSeat,
  userPrompt: string,
  apiKey: string,
): Promise<CouncilResponse> {
  const model = SEAT_MODELS[seat];
  if (!model) throw new Error(`Unknown council seat: ${seat}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
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
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content ?? '';
  return { answer, model, seat };
}
