"use client";
import { useState, useRef, useEffect } from "react";
import { NU_AI_DISCLAIMER } from "@/lib/nuai";
import type { ChatMessage } from "@/lib/nuai";
import "./nuai.css";

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

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;
    const userMsg: ChatMessage = { role: "user", content: text, timestamp: new Date().toISOString() };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/nuai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      if (res.status === 429) { setLimitReached(true); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMessages(m => [...m, data.message]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reach Nu AI");
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
          <p className="nuai-disclaimer">{NU_AI_DISCLAIMER}</p>
        </div>
      )}

      <div className="nuai-messages">
        {messages.map((m, i) => (
          <div key={i} className={`nuai-bubble nuai-bubble--${m.role}`}>
            <p className="nuai-bubble-text">{m.content}</p>
          </div>
        ))}
        {loading && (
          <div className="nuai-bubble nuai-bubble--assistant">
            <p className="nuai-typing">Nu AI is thinking…</p>
          </div>
        )}
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
        <button className="nuai-send" onClick={handleSend} disabled={loading || !input.trim()}>↑</button>
      </div>
      <p className="nuai-footer-disclaimer">Not financial advice · <a href="/terms-of-service">Terms</a></p>
    </div>
  );
}
