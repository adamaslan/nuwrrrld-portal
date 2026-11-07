/**
 * Unit tests for the refresh-free-models probe's production-contract health
 * rule.
 *
 * The probe mirrors fetchWithModelFallbackChecked (lib/openrouter.ts) as
 * invoked by /api/brief: stream: true, max_tokens 350, temperature 0.3, 20s
 * abort. The verdict is the production priming rule — the first visible
 * delta.content token is health; delta.reasoning never counts; [DONE] or
 * stream end without content is "empty". A 1-8 token non-streaming probe was
 * withdrawn after it falsely reported 0/4 alive while the same models served
 * production seconds later (2026-11-02).
 *
 * These tests pin the aligned rule with a mocked fetch: no live OpenRouter
 * calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probe } from "../scripts/refresh-free-models.mjs";

const KEY = "sk-or-v1-test-key";
const MODEL = "vendor/some-model:free";

function sseResponse(chunks: string[], status = 200) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const dataLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const contentDelta = (text: string) => dataLine({ choices: [{ delta: { content: text } }] });
const reasoningDelta = (text: string) => dataLine({ choices: [{ delta: { reasoning: text } }] });
const DONE = "data: [DONE]\n\n";

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refresh-free-models probe — production-contract health", () => {
  it("sends the production-representative request (stream, 350 tokens, temp 0.3)", async () => {
    const fetchMock = stubFetch(sseResponse([contentDelta("OK"), DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: MODEL, max_tokens: 350, temperature: 0.3, stream: true });
  });

  it("passes when the first SSE chunk carries a visible content token", async () => {
    stubFetch(sseResponse([contentDelta("OK"), DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ model: MODEL, ok: true, status: 200 });
    expect(r.detail.parsedLines).toBeGreaterThanOrEqual(1);
  });

  it("rejects a reasoning-only stream as empty — reasoning is not an answer", async () => {
    stubFetch(sseResponse([reasoningDelta("let me think"), reasoningDelta("still thinking"), DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ model: MODEL, ok: false, status: "empty" });
    expect(r.detail.emptyLines).toBe(2);
  });

  it("reassembles a JSON data line split across chunks", async () => {
    const full = contentDelta("OK");
    const mid = Math.floor(full.length / 2);
    stubFetch(sseResponse([full.slice(0, mid), full.slice(mid), DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("skips control frames (comments, blank lines) and still finds content", async () => {
    stubFetch(sseResponse([": OPENROUTER PROCESSING\n\n\n\n", contentDelta("OK"), DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("rejects an immediate [DONE] with no content as empty (shed model)", async () => {
    stubFetch(sseResponse([DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "empty" });
    expect(r.detail.sawDone).toBe(true);
  });

  it("skips a malformed data line and still detects later content", async () => {
    stubFetch(sseResponse(["data: {not json\n\n", contentDelta("OK"), DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("rejects a stream of only malformed lines as empty, without crashing", async () => {
    stubFetch(sseResponse(["data: {not json\n\n", "data: also wrong\n\n"]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "empty" });
  });

  it("records finish_reason in diagnostics (length = budget spent on hidden reasoning)", async () => {
    stubFetch(
      sseResponse([
        dataLine({ choices: [{ delta: { reasoning: "thinking" }, finish_reason: "length" }] }),
        DONE,
      ]),
    );
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "empty" });
    expect(r.detail.finishReason).toBe("length");
  });

  it("rejects a non-200 status without reading a body", async () => {
    stubFetch(sseResponse([], 500));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: 500 });
  });

  it("retries a first-attempt 429 once and passes when the retry streams content", async () => {
    const fetchMock = stubFetch(sseResponse([], 429), sseResponse([contentDelta("OK"), DONE]));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000, retryDelayMs: 0 });
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a repeated 429 as not ok", async () => {
    const fetchMock = stubFetch(sseResponse([], 429), sseResponse([], 429));
    const r = await probe(KEY, MODEL, { timeoutMs: 1000, retryDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an abort as timeout", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, status: "timeout" });
  });

  it("reports a rejected fetch as network", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probe(KEY, MODEL, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "network" });
  });
});
