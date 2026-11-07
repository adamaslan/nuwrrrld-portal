/**
 * Mocked controls for the LIVE harness probeModel (__tests__/live/_harness.ts).
 *
 * probeModel mirrors the production contract — fetchWithModelFallbackChecked
 * as invoked by /api/brief (stream, max_tokens 350, temperature 0.3, 20s
 * abort): the first visible delta.content token is health; delta.reasoning
 * never counts; [DONE]/stream end without content is "empty". These tests pin
 * that rule with a mocked fetch so the live suite's verdicts stay honest
 * without burning free-tier quota. Lives outside __tests__/live/ so it runs
 * in the fast unit project.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeModel } from "./live/_harness";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live harness probeModel — production-contract health", () => {
  it("sends the production-representative request (stream, 350 tokens, temp 0.3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([contentDelta("OK"), DONE]));
    vi.stubGlobal("fetch", fetchMock);
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: MODEL, max_tokens: 350, temperature: 0.3, stream: true });
  });

  it("passes when the first SSE chunk carries a visible content token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([contentDelta("OK"), DONE])));
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r).toMatchObject({ model: MODEL, ok: true, status: 200 });
    expect(typeof r.latencyMs).toBe("number");
  });

  it("rejects a reasoning-only stream as empty — reasoning is not an answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse([reasoningDelta("thinking"), DONE])),
    );
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "empty" });
    expect(r.detail?.emptyLines).toBe(1);
  });

  it("reassembles a JSON data line split across chunks", async () => {
    const full = contentDelta("OK");
    const mid = Math.floor(full.length / 2);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([full.slice(0, mid), full.slice(mid), DONE])));
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("skips control frames (comments, blank lines) and still finds content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse([": OPENROUTER PROCESSING\n\n\n\n", contentDelta("OK"), DONE])),
    );
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("rejects an immediate [DONE] with no content as empty (shed model)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([DONE])));
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "empty" });
  });

  it("rejects a non-200 status without reading a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse([], 500)));
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: 500 });
  });

  it("reports an abort as timeout", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await probeModel(MODEL, KEY, { timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, status: "timeout" });
  });

  it("reports a rejected fetch as network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const r = await probeModel(MODEL, KEY, { timeoutMs: 1000 });
    expect(r).toMatchObject({ ok: false, status: "network" });
  });
});
