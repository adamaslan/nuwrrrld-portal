"use client";

import { useState } from "react";

interface DemoState {
  status: "idle" | "loading" | "ok" | "limited" | "error";
  answer?: string;
  ticker?: string;
  cached?: boolean;
  error?: string;
}

/**
 * No-login "ask the council" widget for the landing page's closing CTA.
 * Ticker-only input — the server builds the actual prompt, so no free text
 * ever reaches the model on behalf of an anonymous caller. One free question
 * per visitor per day (server-enforced); repeat lookups of an already-asked
 * ticker are unlimited (server-cached).
 */
export function PublicCouncilDemo() {
  const [ticker, setTicker] = useState("");
  const [state, setState] = useState<DemoState>({ status: "idle" });

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = ticker.trim();
    if (!trimmed || state.status === "loading") return;

    setState({ status: "loading" });
    try {
      const res = await fetch("/api/council/public", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        setState({ status: "limited", error: data.message ?? "You've used today's free question." });
        return;
      }
      if (!res.ok) {
        setState({ status: "error", error: data.error ?? `Error ${res.status}` });
        return;
      }
      setState({ status: "ok", answer: data.answer, ticker: data.ticker, cached: data.cached });
    } catch {
      setState({ status: "error", error: "Network error — try again." });
    }
  }

  return (
    <div className="public-demo">
      <p className="public-demo-label">Or ask the RISK seat right now — free, no account</p>
      <form className="public-demo-form" onSubmit={handleAsk}>
        <input
          className="public-demo-input"
          type="text"
          placeholder="Ticker, e.g. NVDA"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          maxLength={10}
          disabled={state.status === "loading"}
        />
        <button className="btn secondary public-demo-btn" type="submit" disabled={state.status === "loading" || !ticker.trim()}>
          {state.status === "loading" ? "Asking…" : "Ask RISK"}
        </button>
      </form>

      {state.status === "ok" && (
        <div className="public-demo-result">
          <p className="public-demo-result-label">
            RISK on {state.ticker}
            {state.cached && <span className="public-demo-cached"> · already asked today</span>}
          </p>
          <p className="public-demo-result-text">{state.answer}</p>
        </div>
      )}

      {state.status === "limited" && (
        <p className="public-demo-limited">
          {state.error} <a href="/sign-up">Sign up for unlimited questions →</a>
        </p>
      )}

      {state.status === "error" && <p className="public-demo-error">{state.error}</p>}
    </div>
  );
}
