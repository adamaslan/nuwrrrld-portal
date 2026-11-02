/**
 * Reviewer control (optional): abort DURING the stream read, not just before
 * it. Simulates undici: the fetch signal errors the body stream mid-read.
 * Both probes must report 'timeout', not hang and not 'network'.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeModel } from "./live/_harness";
import { probe } from "../scripts/refresh-free-models.mjs";

function hangingStreamResponse(init: RequestInit) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      init.signal?.addEventListener("abort", () => {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("probe abort bound while awaiting reader.read()", () => {
  it("harness probeModel -> timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_u: string, init: RequestInit) => Promise.resolve(hangingStreamResponse(init))));
    const r = await probeModel("vendor/m:free", "k", { timeoutMs: 50 });
    expect(r).toMatchObject({ ok: false, status: "timeout" });
  });
  it("script probe -> timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_u: string, init: RequestInit) => Promise.resolve(hangingStreamResponse(init))));
    const r = await probe("k", "vendor/m:free", { timeoutMs: 50, retryDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, status: "timeout" });
  });
});
