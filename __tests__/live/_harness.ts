/**
 * Shared helpers for live AI tests.
 *
 * Design rule: a live test asserts *invariants that must hold for any
 * competent completion* — the response is non-empty, it parses, its numbers
 * are grounded, it arrived within budget. It never asserts specific wording.
 * If a test would fail because a model phrased something differently, it is
 * the wrong test.
 */
import { describe } from "vitest";

export const LIVE_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const HAS_KEY = LIVE_KEY.length > 0;

/** `describe` that skips the whole block (loudly, via the setup warning) with no key. */
export const describeLive = HAS_KEY ? describe : describe.skip;

/** Latency budget for a single non-streaming seat call, matching runSeat's own 20s abort. */
export const SEAT_LATENCY_BUDGET_MS = 20_000;

/** Fixture verdict used to build production prompts — realistic, self-consistent numbers. */
export const FIXTURE_VERDICT = {
  ticker: "AAPL",
  verdict: "HOLD",
  confidence: 62,
  confidenceLabel: "medium",
  bias: "bullish",
  industry: "Consumer Electronics",
  rsi: 58.4,
  macd: 1.22,
  adx: 27.5,
  price: 214.36,
  low52w: 164.08,
  high52w: 260.1,
  returns: { "1d": 0.8, "1w": 2.1, "1m": -3.4, "3m": 5.6, "1y": 18.2 },
  signals: [
    { signal: "MACD bullish crossover", strength: "moderate" },
    { signal: "ADX trending", strength: "strong" },
    { signal: "RSI neutral", strength: "weak" },
  ],
  aiOutlook: "Constructive but extended; momentum intact with rotation risk.",
};

/**
 * Counts how many models in a chain actually answered — used to report chain
 * health rather than assert on a specific model, which churns weekly.
 */
export interface ChainProbe {
  model: string;
  status: number;
  ok: boolean;
  latencyMs: number;
}

export async function probeModel(model: string, apiKey: string): Promise<ChainProbe> {
  const started = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://financial.nuwrrrld.com",
      "X-Title": "NuWrrrld live test",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with the single word: OK" }],
      max_tokens: 16,
    }),
  });
  await res.body?.cancel().catch(() => {});
  return { model, status: res.status, ok: res.ok, latencyMs: Date.now() - started };
}

/** Reads an SSE stream to completion, returning the concatenated assistant text. */
export async function drainSSEText(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string; reasoning?: string } }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        text += delta?.content ?? delta?.reasoning ?? "";
      } catch {
        /* malformed frame — the production readers skip these too */
      }
    }
  }
  return text;
}
