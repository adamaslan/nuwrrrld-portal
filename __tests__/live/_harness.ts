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
import { MODEL_ATTEMPT_TIMEOUT_MS } from "@/lib/openrouter";

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
export interface ChainProbeDetail {
  parsedLines: number;
  emptyLines: number;
  sawDone: boolean;
  finishReason: string | null;
}

export interface ChainProbe {
  model: string;
  status: number | string;
  ok: boolean;
  latencyMs: number;
  detail?: ChainProbeDetail;
}

/**
 * Production-contract probe. Mirrors fetchWithModelFallbackChecked as invoked
 * by /api/brief (app/api/brief/route.ts): stream: true, max_tokens 350,
 * temperature 0.3, and the production per-attempt abort
 * (MODEL_ATTEMPT_TIMEOUT_MS, 20s). The verdict is the production priming
 * rule: the FIRST visible delta.content token is health; delta.reasoning
 * never counts; [DONE]/stream-end without any content token is "empty".
 *
 * Certifies the model begins producing visible content under a
 * production-representative request — not answer quality, sustained
 * streaming, or budgets smaller than 350 (the CHAIR verdict second call runs
 * at max_tokens≈80). A 1-16 token non-streaming probe was withdrawn: a
 * reasoning model can spend the tiny budget on hidden reasoning and return
 * 200 with empty content while serving production fine (observed 2026-11-02).
 */
export async function probeModel(
  model: string,
  apiKey: string,
  opts: { timeoutMs?: number } = {},
): Promise<ChainProbe> {
  const timeoutMs = opts.timeoutMs ?? MODEL_ATTEMPT_TIMEOUT_MS;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://financial.nuwrrrld.com",
        "X-Title": "NuWrrrld live test",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: OK" }],
        max_tokens: 350,
        temperature: 0.3,
        stream: true,
      }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { model, status: res.status, ok: false, latencyMs: Date.now() - started };
    }
    // 200 is not health. Production counts only a visible content token as an
    // answer — a shed free model returns 200 with an empty completion — so
    // the probe primes the stream and applies the same rule.
    const verdict = await streamContentVerdict(res);
    return { model, ok: verdict.ok, status: verdict.status, latencyMs: Date.now() - started, detail: verdict.detail };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { model, status: aborted ? "timeout" : "network", ok: false, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Production priming rule on the SSE stream, mirroring scanSSEChunk in
 * lib/openrouter.ts: read until the first visible delta.content token,
 * [DONE], or stream end. Lines not starting with "data: " (control comments
 * such as ": OPENROUTER PROCESSING") are skipped, malformed JSON lines are
 * skipped, delta.reasoning never counts, and partial lines are buffered
 * across chunks. Cancels the body as soon as the verdict is decided.
 */
async function streamContentVerdict(
  res: Response,
): Promise<{ ok: boolean; status: number | string; detail?: ChainProbeDetail }> {
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, status: "empty" };
  const decoder = new TextDecoder();
  let buffered = "";
  let parsedLines = 0;
  let emptyLines = 0;
  let sawDone = false;
  let finishReason: string | null = null;
  const verdict = (ok: boolean, status: number | string) => {
    reader.cancel().catch(() => {});
    return { ok, status, detail: { parsedLines, emptyLines, sawDone, finishReason } };
  };
  for (;;) {
    const { done: streamDone, value } = await reader.read();
    buffered += streamDone ? decoder.decode() : decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    // Production only parses complete newline-terminated data lines.
    const fragment = lines.pop() ?? "";
    buffered = streamDone ? "" : fragment;
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") { sawDone = true; continue; }
      let parsed: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string }> };
      try { parsed = JSON.parse(payload); } catch { continue; }
      parsedLines += 1;
      const choice = parsed?.choices?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (choice?.delta?.content) return verdict(true, res.status);
      emptyLines += 1;
    }
    if (streamDone || sawDone) return verdict(false, "empty");
  }
}
/**
 * Collect newline-delimited SSE content (falling back to reasoning) for live
 * streaming assertions. Malformed frames and [DONE] are ignored; a final frame
 * without a terminating newline is not consumed by this helper.
 */
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
