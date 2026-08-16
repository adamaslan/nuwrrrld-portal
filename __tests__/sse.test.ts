import { describe, expect, it, vi } from "vitest";
import { consumeSSE } from "@/lib/shared/sse";

/** Build a Response whose body streams the given chunks as UTF-8, in order. */
function streamOf(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body);
}

/** One OpenRouter-shaped SSE data line carrying a token. */
function tokenLine(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
}

/** Collect every (delta, accumulated) pair consumeSSE emits. */
async function collect(res: Response) {
  const deltas: string[] = [];
  const accumulations: string[] = [];
  await consumeSSE(res, (delta, accumulated) => {
    deltas.push(delta);
    accumulations.push(accumulated);
  });
  return { deltas, accumulations };
}

describe("consumeSSE", () => {
  it("emits one delta per token and accumulates them in order", async () => {
    const { deltas, accumulations } = await collect(
      streamOf(tokenLine("He"), tokenLine("llo"), tokenLine(" world")),
    );
    expect(deltas).toEqual(["He", "llo", " world"]);
    expect(accumulations).toEqual(["He", "Hello", "Hello world"]);
  });

  it("stops at [DONE] and ignores anything after it", async () => {
    const { deltas } = await collect(
      streamOf(tokenLine("kept"), "data: [DONE]\n", tokenLine("dropped")),
    );
    expect(deltas).toEqual(["kept"]);
  });

  it("reassembles a JSON payload split across chunk boundaries", async () => {
    // The network can split mid-token; the parser must buffer until a full line arrives.
    const { deltas } = await collect(
      streamOf('data: {"choices":[{"delta":{"con', 'tent":"split"}}]}\n'),
    );
    expect(deltas).toEqual(["split"]);
  });

  it("reassembles a multi-byte UTF-8 character split across chunks", async () => {
    const encoder = new TextEncoder();
    const full = encoder.encode(tokenLine("é"));
    const cut = full.length - 4; // slice through the 2-byte "é"
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(full.slice(0, cut));
        controller.enqueue(full.slice(cut));
        controller.close();
      },
    });
    const { deltas } = await collect(new Response(body));
    expect(deltas).toEqual(["é"]);
  });

  it("flushes a final line that arrives without a trailing newline", async () => {
    const withoutNewline = tokenLine("last").replace(/\n$/, "");
    const { deltas } = await collect(streamOf(withoutNewline));
    expect(deltas).toEqual(["last"]);
  });

  it("skips malformed JSON without aborting the stream", async () => {
    const { deltas } = await collect(
      streamOf(tokenLine("before"), "data: {not json\n", tokenLine("after")),
    );
    expect(deltas).toEqual(["before", "after"]);
  });

  it("ignores SSE comment and non-data lines", async () => {
    const { deltas } = await collect(
      streamOf(": keep-alive\n", "event: message\n", tokenLine("only")),
    );
    expect(deltas).toEqual(["only"]);
  });

  it("does not emit for a delta with no content (e.g. role-only opening frame)", async () => {
    const roleFrame = `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n`;
    const { deltas } = await collect(streamOf(roleFrame, tokenLine("text")));
    expect(deltas).toEqual(["text"]);
  });

  it("does not emit for an empty-string delta", async () => {
    const { deltas } = await collect(streamOf(tokenLine(""), tokenLine("real")));
    expect(deltas).toEqual(["real"]);
  });

  it("tolerates a payload with no choices array", async () => {
    const { deltas } = await collect(
      streamOf('data: {"id":"x"}\n', tokenLine("survived")),
    );
    expect(deltas).toEqual(["survived"]);
  });

  it("emits nothing for an empty stream", async () => {
    const { deltas } = await collect(streamOf());
    expect(deltas).toEqual([]);
  });

  it("throws when the response has no readable body", async () => {
    await expect(consumeSSE({ body: null } as Response, () => {})).rejects.toThrow(
      "SSE response body is not readable",
    );
  });

  it("releases the reader when the stream completes", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(tokenLine("x")) })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const res = { body: { getReader: () => ({ read, cancel }) } } as unknown as Response;

    await consumeSSE(res, () => {});
    expect(cancel).toHaveBeenCalled();
  });

  // Sharp edge worth pinning: the try/catch that guards JSON.parse also wraps the
  // onDelta call, so an exception thrown by the *consumer* is swallowed exactly
  // like a malformed line — the stream keeps draining and consumeSSE resolves
  // normally. Callers must not rely on their own errors propagating out of here.
  it("swallows a throwing consumer callback and still drains the stream", async () => {
    const onDelta = vi.fn(() => {
      throw new Error("consumer blew up");
    });

    await expect(
      consumeSSE(streamOf(tokenLine("a"), tokenLine("b")), onDelta),
    ).resolves.toBeUndefined();
    expect(onDelta).toHaveBeenCalledTimes(2);
  });
});
