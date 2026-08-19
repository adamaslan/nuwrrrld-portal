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
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
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
/**
 * Make a string safe to send as an HTTP header value.
 *
 * Header values are ByteStrings: any code point above 255 makes `fetch` throw a
 * TypeError *before the request is sent*. In a fallback chain that failure is
 * indistinguishable from an unreachable model — the catch advances to the next
 * one, every model "fails" without ever recording a status, and the chain ends
 * with its initial 503 rather than the truth. That is exactly how an em-dash in
 * one caller's `X-Title` made the precompute batch report "all models in chain
 * failed" while OpenRouter was answering 429 to everyone else.
 *
 * Non-Latin-1 characters are replaced rather than stripped so the title stays
 * readable, and a run is never lost to a decorative character in a log label.
 */
export function toHeaderSafe(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7E]/g, (ch) => (ch === '\u2014' || ch === '\u2013' ? '-' : '?'));
}

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
          'X-Title': toHeaderSafe(appTitle),
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

/** Parses one buffered chunk of raw SSE text for `data: ` lines, reporting
 * whether any assistant content/reasoning token was seen and whether `[DONE]`
 * arrived. Reads both `delta.content` and `delta.reasoning` — a model that
 * streams only into `reasoning` (never `content`) should not be misread as
 * having produced nothing (see docs/portfolio-health-ai-workflow.html BUG-4). */
function scanSSEChunk(raw: string): { remaining: string; sawContent: boolean; sawDone: boolean; parsedLines: number; emptyLines: number } {
  const lines = raw.split('\n');
  const remaining = lines.pop() ?? '';
  let sawContent = false;
  let sawDone = false;
  let parsedLines = 0;
  let emptyLines = 0;
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') { sawDone = true; continue; }
    try {
      const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string; reasoning?: string } }> };
      parsedLines += 1;
      const delta = parsed?.choices?.[0]?.delta;
      // Only a visible content token counts as a usable response. A
      // reasoning-only stream (delta.reasoning with no delta.content) would
      // otherwise pass this check while the caller's route parser — which
      // reads only delta.content — sees nothing, producing a "successful"
      // empty answer instead of falling back to the next model.
      if (delta?.content) sawContent = true;
      else emptyLines += 1;
    } catch { /* skip malformed */ }
  }
  return { remaining, sawContent, sawDone, parsedLines, emptyLines };
}

/**
 * Like `fetchWithModelFallback`, but additionally treats an HTTP-200 response
 * that never emits a single content/reasoning token as a failure and retries
 * the next model — closing the gap where `fetchWithModelFallback` falls back
 * on HTTP status only (BUG-5). Only "primes" each candidate (buffers raw bytes
 * until the first token or stream-end) rather than fully buffering to
 * completion, so a healthy model streams to the caller with effectively the
 * same latency as `fetchWithModelFallback` — the extra cost is paid only on
 * the empty-completion path, which was already a dead end for the caller.
 *
 * Deliberately a separate function rather than a mode flag on
 * `fetchWithModelFallback`: `/api/nuai` and `/api/brief` call that one and
 * have different latency/blast-radius tolerances; this one is opt-in per
 * caller (currently `/api/portfolio/health-ai` only).
 */
export async function fetchWithModelFallbackChecked(
  apiKey: string,
  baseBody: Record<string, unknown>,
  appTitle: string,
  signal?: AbortSignal,
): Promise<{ response: Response; model: string }> {
  let lastStatus = 503;
  let anyEmptyModel = false;

  for (const model of FREE_MODEL_CHAIN) {
    let response: Response;
    try {
      response = await fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://financial.nuwrrrld.com',
          'X-Title': toHeaderSafe(appTitle),
        },
        body: JSON.stringify({ ...baseBody, model }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      continue;
    }

    if (!response.ok) {
      lastStatus = response.status;
      await response.body?.cancel().catch(() => {});
      if (response.status !== 402 && response.status !== 429 && response.status < 500) break;
      continue;
    }

    const reader = response.body?.getReader();
    if (!reader) { continue; }
    const decoder = new TextDecoder();
    let bufferedRaw = '';
    let sawContent = false;
    let sawDone = false;
    let parsedLines = 0;
    let emptyLines = 0;
    let streamEnded = false;

    while (!sawContent && !streamEnded) {
      const { done, value } = await reader.read();
      if (done) { streamEnded = true; bufferedRaw += decoder.decode(); break; }
      bufferedRaw += decoder.decode(value, { stream: true });
      const scan = scanSSEChunk(bufferedRaw);
      sawContent = scan.sawContent;
      sawDone = sawDone || scan.sawDone;
      parsedLines += scan.parsedLines;
      emptyLines += scan.emptyLines;
      if (scan.sawDone && !sawContent) { streamEnded = true; break; }
    }

    console.info(
      `[openrouter] health-ai attempt model=${model} status=200 sawContent=${sawContent} ` +
      `parsedLines=${parsedLines} emptyLines=${emptyLines} sawDone=${sawDone} streamEnded=${streamEnded}`,
    );

    if (!sawContent) {
      // This model produced zero usable tokens — advance to the next one
      // instead of handing the caller a "successful" empty stream.
      anyEmptyModel = true;
      reader.cancel().catch(() => {});
      continue;
    }

    // Reconstruct the stream: replay the buffered priming bytes, then keep
    // pumping the same underlying reader untouched for the rest.
    const enc = new TextEncoder();
    const combined = new ReadableStream({
      start(ctrl) {
        if (bufferedRaw) ctrl.enqueue(enc.encode(bufferedRaw));
      },
      async pull(ctrl) {
        const { done, value } = await reader.read();
        if (done) { ctrl.close(); return; }
        ctrl.enqueue(value);
      },
      cancel() { reader.cancel().catch(() => {}); },
    });

    return { response: new Response(combined, { headers: response.headers }), model };
  }

  throw new Error(
    anyEmptyModel
      ? 'OpenRouter: all models in chain returned empty completions'
      : `OpenRouter ${lastStatus}: all models in chain failed`,
  );
}

/**
 * A 404/400 that means "this model id no longer exists". OpenRouter returns
 * 404 for a retired id and 400 for one it cannot route at all — both are
 * permanent for *that model* and say nothing about the next one.
 */
function isRetiredModelStatus(status: number): boolean {
  return status === 404 || status === 400;
}

/**
 * Whether a failed attempt should advance to the next model.
 *
 * 402 (free-tier quota) / 429 (rate limit) / 5xx are transient-or-per-model
 * everywhere, so they always advance.
 *
 * The subtle case is 404/400, and the answer depends on *position*, not status.
 * On the **primary** model — a hand-maintained `SEAT_MODELS` literal with no
 * scheduled maintainer — a 404 overwhelmingly means the id was retired from
 * the catalog, which is precisely what the fallback chain exists for. Treating
 * it as fatal there made a single rotted id *disable* a seat rather than
 * degrade it, even while every chain model was healthy (2026-08-18: five of
 * six seats were in this state).
 *
 * Within the **chain** the same status means something different: those ids
 * are rewritten weekly by scripts/refresh-free-models.mjs against the live
 * catalog, so a 404 there points at a malformed request — a bad prompt shape,
 * an unsupported parameter — that will fail identically on every remaining
 * model. Retrying it burns the whole chain's latency to reach the same error.
 *
 * Auth (401/403) is fatal in both positions: it is a property of the key, not
 * the model.
 */
function isRetryableStatus(status: number, isPrimary: boolean): boolean {
  if (status === 402 || status === 429 || status >= 500) return true;
  return isPrimary && isRetiredModelStatus(status);
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
  for (const [index, model] of modelChain.entries()) {
    const isPrimary = index === 0;
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
      if (!isRetryableStatus(res.status, isPrimary)) break;
      if (isPrimary && isRetiredModelStatus(res.status)) {
        // Loud, because nothing else surfaces it: the seat still answers via
        // the chain, so a rotted SEAT_MODELS entry is otherwise invisible
        // until someone audits the catalog by hand.
        console.warn(
          `[openrouter] seat=${seat} primary model ${model} returned ${res.status} — ` +
          `likely retired from the catalog. Falling through to FREE_MODEL_CHAIN. ` +
          `Update SEAT_MODELS (see scripts/refresh-free-models.mjs).`,
        );
      }
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
