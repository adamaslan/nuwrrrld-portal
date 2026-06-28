"use client";
import { useState, useRef, useEffect } from "react";
import { NU_AI_DISCLAIMER } from "@/lib/nuai";
import type { ChatMessage } from "@/lib/nuai";
import "./nuai.css";

const SUGGESTED_PROMPTS = [
  "Explain today's signals",
  "What's the market tone?",
  "Is my watchlist overconcentrated?",
  "What does RSI indicate right now?",
];

export function NuAIChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(overrideText?: string) {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date().toISOString() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    // Add a streaming assistant placeholder
    const assistantPlaceholder: ChatMessage = { role: "assistant", content: "", timestamp: new Date().toISOString() };
    setMessages(m => [...m, assistantPlaceholder]);

    try {
      const res = await fetch("/api/nuai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });

      if (res.status === 429) { setLimitReached(true); return; }
      if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error === "upgrade_required"
          ? "Nu AI requires a Pro subscription. Upgrade to continue."
          : `HTTP 403`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get("content-type") ?? "";

      if (contentType.includes("text/event-stream") && res.body) {
        // Streaming path: parse SSE and accumulate tokens
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        outer: while (true) {
          const { done: readDone, value } = await reader.read();
          if (readDone) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6).trim();
            if (payload === "[DONE]") break outer;
            try {
              const parsed = JSON.parse(payload);
              const delta = parsed?.choices?.[0]?.delta?.content ?? "";
              if (delta) {
                accumulated += delta;
                const snap = accumulated;
                setMessages(m => {
                  const copy = [...m];
                  const last = copy[copy.length - 1];
                  if (last?.role === "assistant") {
                    copy[copy.length - 1] = { ...last, content: snap };
                  }
                  return copy;
                });
              }
            } catch {
              // ignore malformed SSE lines
            }
          }
        }
      } else {
        // Fallback: non-streaming JSON response
        const data = await res.json();
        setMessages(m => {
          const copy = [...m];
          copy[copy.length - 1] = data.message;
          return copy;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reach Nu AI");
      // Remove the empty placeholder on error
      setMessages(m => m.filter((_, i) => i !== m.length - 1 || m[m.length - 1].content !== ""));
    } finally {
      setLoading(false);
    }
  }

  if (limitReached) {
    return (
      <div className="nuai-limit">
        <p className="nuai-limit-emoji">⏰</p>
        <p className="nuai-limit-title">Daily limit reached</p>
        <p className="nuai-limit-sub">Your Nu AI quota resets at midnight UTC.</p>
      </div>
    );
  }

  return (
    <div className="nuai-container">
      {messages.length === 0 && (
        <div className="nuai-empty">
          <p className="nuai-empty-emoji">🤖</p>
          <p className="nuai-empty-title">Nu AI</p>
          <p className="nuai-empty-sub">Ask about your portfolio, signals, or market concepts.</p>
          <div className="nuai-chips">
            {SUGGESTED_PROMPTS.map(p => (
              <button key={p} className="nuai-chip" onClick={() => handleSend(p)}>
                {p}
              </button>
            ))}
          </div>
          <p className="nuai-disclaimer">{NU_AI_DISCLAIMER}</p>
        </div>
      )}

      <div className="nuai-messages">
        {messages.map((m, i) => (
          <div key={i} className={`nuai-bubble nuai-bubble--${m.role}`}>
            {m.role === "assistant" && m.content === "" && loading ? (
              <p className="nuai-typing">Nu AI is thinking…</p>
            ) : (
              <p className="nuai-bubble-text">{m.content}</p>
            )}
          </div>
        ))}
        {error && <p className="nuai-error">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <div className="nuai-input-row">
        <textarea
          className="nuai-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Ask Nu AI…"
          rows={2}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); handleSend(); } }}
        />
        <button className="nuai-send" onClick={() => handleSend()} disabled={loading || !input.trim()}>↑</button>
      </div>
      <p className="nuai-footer-disclaimer">Not financial advice · <a href="/terms-of-service">Terms</a></p>
    </div>
  );
}
