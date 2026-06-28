/**
 * consumeSSE — shared SSE stream parser for both mobile and web.
 *
 * Reads an OpenRouter-style `text/event-stream` response and calls
 * `onDelta(delta, accumulated)` for every assistant text token received.
 * Stops cleanly on `[DONE]` or end-of-stream.
 *
 * Works in any runtime that supports the Fetch `ReadableStream` API
 * (browser, React Native / Hermes 0.72+, Node 18+, Edge).
 */
export async function consumeSSE(
  res: Response,
  onDelta: (delta: string, accumulated: string) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") break outer;
        try {
          const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const delta = parsed?.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            accumulated += delta;
            onDelta(delta, accumulated);
          }
        } catch { /* skip malformed SSE line */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
