/**
 * Unit tests for the refresh-free-models probe's content-aware health rule.
 *
 * The probe used to trust HTTP 200 alone, so a shed free model (200 with an
 * empty completion) was written into FREE_MODEL_CHAIN as "healthy" even though
 * production (fetchWithModelFallbackChecked) counts only a visible content
 * token as an answer. These tests pin the aligned rule with a mocked fetch:
 * no live OpenRouter calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probe } from "../scripts/refresh-free-models.mjs";

const KEY = "sk-or-v1-test-key";
const MODEL = "vendor/some-model:free";

function chatJson(content: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refresh-free-models probe — content-aware health", () => {
  it("passes a 200 whose completion carries a visible content token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatJson("OK"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toEqual({ model: MODEL, ok: true, status: 200 });
  });

  it("rejects a 200 with an empty completion (shed model) as empty, not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatJson(""));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toEqual({ model: MODEL, ok: false, status: "empty" });
  });

  it("rejects a 200 whose tokens went only to hidden reasoning (content empty)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "", reasoning: "hmm" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toEqual({ model: MODEL, ok: false, status: "empty" });
  });

  it("rejects a 200 with an unparseable body as malformed, not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not json at all", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toEqual({ model: MODEL, ok: false, status: "malformed" });
  });

  it("keeps the retry-classification contract for error statuses (402 = quota)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toEqual({ model: MODEL, ok: false, status: 402 });
  });

  it("retries a 429 once, then judges the retry by content", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(chatJson("OK"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 1000, retryDelayMs: 1 });
    expect(r).toEqual({ model: MODEL, ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an abort as timeout", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 30 });
    expect(r).toEqual({ model: MODEL, ok: false, status: "timeout" });
  });
});
