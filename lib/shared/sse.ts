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
  if (!res.body) throw new Error("SSE response body is not readable");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  const processLines = (raw: string): boolean => {
    const lines = raw.split("\n");
    const remaining = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") { buffer = remaining; return true; }
      try {
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        const delta = parsed?.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          accumulated += delta;
          onDelta(delta, accumulated);
        }
      } catch { /* skip malformed SSE line */ }
    }
    buffer = remaining;
    return false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any remaining data that arrived without a trailing newline
        buffer += decoder.decode();
        if (buffer) processLines(buffer + "\n");
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      if (processLines(buffer)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
