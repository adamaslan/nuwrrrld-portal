/**
 * The OpenRouter transport contract, with `fetch` stubbed.
 *
 * Complements __tests__/live/model-chain.live.test.ts rather than duplicating
 * it. The live suite proves the models *exist and answer*; this suite proves
 * the fallback *logic* is correct — including the failure shapes a live test
 * can never reliably produce on demand: a 402 on the first model, a 429 storm,
 * a 200 that streams zero content tokens, a mid-chain network drop, an abort
 * from the caller.
 *
 * Design rule mirrors _harness.ts: assert transport behaviour and never a
 * model id. FREE_MODEL_CHAIN is rewritten weekly by
 * scripts/refresh-free-models.mjs, so any test that pins an id turns a routine
 * refresh into a red build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FREE_MODEL_CHAIN,
  fetchWithModelFallback,
  fetchWithModelFallbackChecked,
  runSeat,
  toHeaderSafe,
} from "@/lib/openrouter";

const KEY = "sk-or-v1-test-key-not-real";

/** Body of one SSE frame carrying a visible content token. */
function contentFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

/** A frame carrying ONLY reasoning — the BUG-4 shape. Renders as nothing. */
function reasoningFrame(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { reasoning: text } }] })}\n\n`;
}

/** Builds a streaming 200 Response from raw SSE text. */
function sseResponse(raw: string, status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(raw));
      ctrl.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

/** A non-streaming JSON completion, the shape runSeat parses. */
function jsonCompletion(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An error response with a readable body, so body-drain behaviour is exercised. */
function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { code: status } }), { status });
}

/**
 * Installs a fetch stub that replies according to `plan`, indexed by the
 * order calls arrive. Returns the recorded request bodies so tests can assert
 * *which* model each attempt used without hardcoding ids.
 */
function stubFetchSequence(plan: Array<() => Response | Promise<Response>>) {
  const modelsTried: string[] = [];
  let call = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body)) as { model: string };
    modelsTried.push(body.model);
    const step = plan[Math.min(call, plan.length - 1)];
    call += 1;
    return step();
  });
  return { modelsTried, spy };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchWithModelFallback — retry classification", () => {
  it("advances past a 402 (free-tier quota exhausted) to the next model", async () => {
    const { modelsTried } = stubFetchSequence([
      () => errorResponse(402),
      () => sseResponse(contentFrame("ok")),
    ]);

    const { model } = await fetchWithModelFallback(KEY, { messages: [] }, "test");

    expect(modelsTried).toHaveLength(2);
    // The second model in the chain served it — asserted positionally, not by id.
    expect(model).toBe(modelsTried[1]);
    expect(FREE_MODEL_CHAIN as readonly string[]).toContain(model);
  });

  it("advances past a 429 (rate limit)", async () => {
    const { modelsTried } = stubFetchSequence([
      () => errorResponse(429),
      () => sseResponse(contentFrame("ok")),
    ]);
    await fetchWithModelFallback(KEY, { messages: [] }, "test");
    expect(modelsTried).toHaveLength(2);
  });

  it("advances past a 500 (provider fault)", async () => {
    const { modelsTried } = stubFetchSequence([
      () => errorResponse(503),
      () => sseResponse(contentFrame("ok")),
    ]);
    await fetchWithModelFallback(KEY, { messages: [] }, "test");
    expect(modelsTried).toHaveLength(2);
  });

  it("stops immediately on a 401 instead of walking the whole chain", async () => {
    // A bad key is fatal for every model — retrying it burns the full chain's
    // latency budget to reach the same answer. This is the stubbed twin of the
    // live "fails loudly rather than hanging" test.
    const { modelsTried } = stubFetchSequence([() => errorResponse(401)]);

    await expect(fetchWithModelFallback(KEY, { messages: [] }, "test")).rejects.toThrow(
      /OpenRouter 401/,
    );
    expect(modelsTried).toHaveLength(1);
  });

  it("stops immediately on a 400 (malformed request)", async () => {
    const { modelsTried } = stubFetchSequence([() => errorResponse(400)]);
    await expect(fetchWithModelFallback(KEY, { messages: [] }, "test")).rejects.toThrow(
      /OpenRouter 400/,
    );
    expect(modelsTried).toHaveLength(1);
  });

  it("tries every model before giving up, and reports the last status", async () => {
    const { modelsTried } = stubFetchSequence([() => errorResponse(429)]);

    await expect(fetchWithModelFallback(KEY, { messages: [] }, "test")).rejects.toThrow(
      /all models in chain failed/,
    );
    expect(modelsTried).toHaveLength(FREE_MODEL_CHAIN.length);
    // No model is skipped and none is tried twice — a chain that silently
    // dropped an entry would still "pass" a looser length-only assertion.
    expect(new Set(modelsTried).size).toBe(FREE_MODEL_CHAIN.length);
  });

  it("treats a network error as transient and continues the chain", async () => {
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new TypeError("fetch failed");
      return sseResponse(contentFrame("ok"));
    });

    const { response } = await fetchWithModelFallback(KEY, { messages: [] }, "test");
    expect(response.ok).toBe(true);
    expect(call).toBe(2);
  });

  it("re-throws a caller abort instead of swallowing it as a transient error", async () => {
    // The distinction matters: a user navigating away must not cause the route
    // to grind through every remaining model on their behalf.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });

    const ctrl = new AbortController();
    await expect(
      fetchWithModelFallback(KEY, { messages: [] }, "test", ctrl.signal),
    ).rejects.toThrow(/aborted/);
  });

  it("sends attribution headers on every attempt", async () => {
    // OpenRouter free-tier eligibility depends on these; losing them silently
    // downgrades the account rather than erroring.
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(contentFrame("ok")));
    await fetchWithModelFallback(KEY, { messages: [] }, "MyAppTitle");

    const init = spy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["HTTP-Referer"]).toBe("https://financial.nuwrrrld.com");
    expect(headers["X-Title"]).toBe("MyAppTitle");
  });

  it("never sends a caller-supplied model — the chain owns model selection", async () => {
    const { modelsTried } = stubFetchSequence([() => sseResponse(contentFrame("ok"))]);
    // A caller that passes `model` in baseBody must not be able to pin the
    // chain to an arbitrary (possibly paid) model.
    await fetchWithModelFallback(
      KEY,
      { messages: [], model: "openai/gpt-4o" } as Record<string, unknown>,
      "test",
    );
    expect(modelsTried[0]).not.toBe("openai/gpt-4o");
    expect(FREE_MODEL_CHAIN as readonly string[]).toContain(modelsTried[0]);
  });
});

describe("fetchWithModelFallbackChecked — empty-completion detection (BUG-5)", () => {
  it("rejects an HTTP-200 stream that carries no content tokens and tries the next model", async () => {
    const { modelsTried } = stubFetchSequence([
      () => sseResponse("data: [DONE]\n\n"),
      () => sseResponse(contentFrame("real answer")),
    ]);

    const { model } = await fetchWithModelFallbackChecked(KEY, { messages: [] }, "test");
    expect(modelsTried).toHaveLength(2);
    expect(model).toBe(modelsTried[1]);
  });

  it("rejects a reasoning-only stream (BUG-4) — invisible tokens are not an answer", async () => {
    // A model that emits only `delta.reasoning` passes a naive status check
    // while the route's parser (which reads `delta.content`) renders nothing.
    const { modelsTried } = stubFetchSequence([
      () => sseResponse(reasoningFrame("thinking...") + "data: [DONE]\n\n"),
      () => sseResponse(contentFrame("visible")),
    ]);

    await fetchWithModelFallbackChecked(KEY, { messages: [] }, "test");
    expect(modelsTried).toHaveLength(2);
  });

  it("distinguishes an all-empty chain from an all-erroring chain in its message", async () => {
    // These are different operational problems: empty completions mean the
    // models are reachable but useless (a prompt/model-quality issue), while
    // status failures mean quota/auth/outage. One error string for both would
    // send the on-call reader down the wrong path.
    stubFetchSequence([() => sseResponse("data: [DONE]\n\n")]);
    await expect(fetchWithModelFallbackChecked(KEY, { messages: [] }, "test")).rejects.toThrow(
      /empty completions/,
    );

    vi.restoreAllMocks();
    stubFetchSequence([() => errorResponse(429)]);
    await expect(fetchWithModelFallbackChecked(KEY, { messages: [] }, "test")).rejects.toThrow(
      /all models in chain failed/,
    );
  });

  it("replays the primed bytes so the caller sees the whole stream, not just the tail", async () => {
    // The priming read consumes the first chunk to check for content. If those
    // bytes were not replayed, the user would lose the opening of every answer
    // — a silent truncation that looks like a model quirk.
    stubFetchSequence([() => sseResponse(contentFrame("Hello ") + contentFrame("world"))]);

    const { response } = await fetchWithModelFallbackChecked(KEY, { messages: [] }, "test");
    const text = await response.text();
    expect(text).toContain("Hello ");
    expect(text).toContain("world");
  });

  it("preserves the upstream response headers on the reconstructed stream", async () => {
    stubFetchSequence([() => sseResponse(contentFrame("ok"))]);
    const { response } = await fetchWithModelFallbackChecked(KEY, { messages: [] }, "test");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("skips malformed SSE frames without treating them as content", async () => {
    // A garbage frame must not count as a usable token — otherwise a model
    // emitting only noise would be accepted as healthy.
    const { modelsTried } = stubFetchSequence([
      () => sseResponse("data: {not json\n\ndata: [DONE]\n\n"),
      () => sseResponse(contentFrame("ok")),
    ]);
    await fetchWithModelFallbackChecked(KEY, { messages: [] }, "test");
    expect(modelsTried).toHaveLength(2);
  });
});

describe("runSeat — per-seat chain composition", () => {
  it("tries the seat's primary model first, then the free chain", async () => {
    const { modelsTried } = stubFetchSequence([
      () => errorResponse(429),
      () => jsonCompletion("an answer"),
    ]);

    const result = await runSeat("QUANT", [{ role: "user", content: "hi" }], KEY, 32);

    expect(result.answer).toBe("an answer");
    expect(result.seat).toBe("QUANT");
    // The first attempt is the seat's primary; the second comes from the chain.
    expect(FREE_MODEL_CHAIN as readonly string[]).toContain(modelsTried[1]);
  });

  it("never retries the primary model a second time via the chain", async () => {
    // The chain is filtered against the primary; a duplicate would waste one
    // of only a handful of fallback slots on a model already known to fail.
    const { modelsTried } = stubFetchSequence([() => errorResponse(429)]);
    await expect(runSeat("QUANT", [{ role: "user", content: "hi" }], KEY, 32)).rejects.toThrow();
    expect(new Set(modelsTried).size).toBe(modelsTried.length);
  });

  it("honours a model override ahead of the seat default", async () => {
    const { modelsTried } = stubFetchSequence([() => jsonCompletion("ok")]);
    await runSeat("T1", [{ role: "user", content: "hi" }], KEY, 32, 0.4, "vendor/override-model");
    expect(modelsTried[0]).toBe("vendor/override-model");
  });

  it("reports latency and the serving model for observability", async () => {
    stubFetchSequence([() => jsonCompletion("ok")]);
    const result = await runSeat("T1", [{ role: "user", content: "hi" }], KEY, 32);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.model).toBe("string");
    expect(result.model.length).toBeGreaterThan(0);
  });

  it("returns an empty string rather than throwing when a 200 has no content", async () => {
    // runSeat (unlike fetchWithModelFallbackChecked) does not treat this as a
    // failure. Pinning the current behaviour so a future change to make it
    // fall through is a deliberate, visible edit rather than an accident.
    stubFetchSequence([() => new Response(JSON.stringify({ choices: [] }), { status: 200 })]);
    const result = await runSeat("T1", [{ role: "user", content: "hi" }], KEY, 32);
    expect(result.answer).toBe("");
  });

  it("falls through to the chain when the PRIMARY model is retired (404)", async () => {
    // The 2026-08-18 defect: five of six SEAT_MODELS primaries no longer
    // existed, and a 404 broke the loop before the chain was ever tried — so
    // one rotted literal *disabled* a seat instead of degrading it, even with
    // every chain model healthy.
    const { modelsTried } = stubFetchSequence([
      () => errorResponse(404),
      () => jsonCompletion("served by the chain"),
    ]);

    const result = await runSeat("QUANT", [{ role: "user", content: "hi" }], KEY, 32);

    expect(result.answer).toBe("served by the chain");
    expect(modelsTried).toHaveLength(2);
    expect(FREE_MODEL_CHAIN as readonly string[]).toContain(modelsTried[1]);
  });

  it("falls through when the primary is unroutable (400)", async () => {
    const { modelsTried } = stubFetchSequence([
      () => errorResponse(400),
      () => jsonCompletion("ok"),
    ]);
    await runSeat("QUANT", [{ role: "user", content: "hi" }], KEY, 32);
    expect(modelsTried).toHaveLength(2);
  });

  it("does NOT retry a 404 that comes from a chain model", async () => {
    // Chain ids are refreshed weekly against the live catalog, so a 404 there
    // indicates a malformed request that will fail identically on every
    // remaining model — retrying burns the whole chain to reach the same error.
    const { modelsTried } = stubFetchSequence([
      () => errorResponse(429), // primary: transient, advances
      () => errorResponse(404), // first chain model: fatal, must stop
      () => jsonCompletion("should never be reached"),
    ]);

    await expect(runSeat("QUANT", [{ role: "user", content: "hi" }], KEY, 32)).rejects.toThrow(
      /OpenRouter 404/,
    );
    expect(modelsTried).toHaveLength(2);
  });

  it("still treats auth failures as fatal on the primary", async () => {
    // 401 is a property of the key, not the model — falling through would
    // burn the entire chain to rediscover the same bad credential.
    const { modelsTried } = stubFetchSequence([() => errorResponse(401)]);
    await expect(runSeat("QUANT", [{ role: "user", content: "hi" }], KEY, 32)).rejects.toThrow(
      /OpenRouter 401/,
    );
    expect(modelsTried).toHaveLength(1);
  });

  it("warns loudly when a primary model looks retired", async () => {
    // The seat still answers, so without this warning a rotted SEAT_MODELS
    // entry stays invisible until someone audits the catalog by hand.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetchSequence([() => errorResponse(404), () => jsonCompletion("ok")]);

    await runSeat("QUANT", [{ role: "user", content: "hi" }], KEY, 32);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/SEAT_MODELS/);
  });

  it("names the seat in the error when the whole chain fails", async () => {
    stubFetchSequence([() => errorResponse(503)]);
    await expect(runSeat("MACRO", [{ role: "user", content: "hi" }], KEY, 32)).rejects.toThrow(
      /council MACRO/,
    );
  });

  it("passes max_tokens and temperature through to the provider", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonCompletion("ok"));
    await runSeat("T1", [{ role: "user", content: "hi" }], KEY, 123, 0.9);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.max_tokens).toBe(123);
    expect(body.temperature).toBe(0.9);
  });
});

describe("FREE_MODEL_CHAIN — invariants that hold without network access", () => {
  it("is non-empty, so no build can ship with zero models", () => {
    expect(FREE_MODEL_CHAIN.length).toBeGreaterThan(0);
  });

  it("keeps a fallback margin of at least two entries", () => {
    // A one-model chain is a single point of failure with the *appearance* of
    // redundancy. refresh-free-models.mjs can write a short chain when few
    // models probe healthy; this catches that reaching main.
    expect(
      FREE_MODEL_CHAIN.length,
      "FREE_MODEL_CHAIN has no fallback margin — run scripts/refresh-free-models.mjs",
    ).toBeGreaterThan(1);
  });

  it("contains only :free ids, so a refresh can never introduce a billed model", () => {
    for (const model of FREE_MODEL_CHAIN) {
      expect(model, `${model} is not a :free id`).toMatch(/:free$/);
    }
  });

  it("has no duplicate entries", () => {
    // A duplicate silently shrinks the real fallback depth below the visible
    // length — the chain looks four deep but retries the same model twice.
    expect(new Set(FREE_MODEL_CHAIN).size).toBe(FREE_MODEL_CHAIN.length);
  });

  it("uses well-formed vendor/model ids", () => {
    for (const model of FREE_MODEL_CHAIN) {
      expect(model, `${model} is not vendor/model shaped`).toMatch(/^[\w.-]+\/[\w.:-]+$/);
    }
  });
});

describe("toHeaderSafe — X-Title must survive as an HTTP header", () => {
  // Header values are ByteStrings: a code point above 255 makes fetch() throw
  // a TypeError *before sending*. Inside the fallback chain that is caught and
  // treated as an unreachable model, so every model "fails" without recording
  // a status and the chain reports its initial 503. A real em-dash in one
  // caller's title made the precompute batch report "all models in chain
  // failed" while OpenRouter was answering 429 — the wrong cause entirely,
  // and it suppressed the quota-exhausted early stop that reads that status.
  it("rewrites dashes that would otherwise throw", () => {
    expect(toHeaderSafe("NuWrrrld Precompute — Portfolio Health")).toBe(
      "NuWrrrld Precompute - Portfolio Health",
    );
    expect(toHeaderSafe("en–dash")).toBe("en-dash");
  });

  it("leaves plain ASCII untouched", () => {
    expect(toHeaderSafe("NuWrrrld Financial Daily Brief")).toBe("NuWrrrld Financial Daily Brief");
  });

  it("produces a value the Headers constructor accepts", () => {
    for (const title of [
      "NuWrrrld Precompute — Portfolio Health",
      "emoji 🚀 here",
      "curly \u2018quotes\u2019",
      "plain",
    ]) {
      const safe = toHeaderSafe(title);
      expect(() => new Headers({ "X-Title": safe })).not.toThrow();
      // The raw form is what would have thrown; the guard is what makes it safe.
      expect(safe).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});
