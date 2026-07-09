"use client";
import { useState, useMemo, useEffect } from "react";
import type { SignalPayload } from "@/lib/digest";
import { SignalShareButton } from "@/components/SignalShareButton";

interface Props {
  signals: SignalPayload[];
}

type Direction = "all" | "bullish" | "bearish" | "neutral";
type SortKey = "confidence" | "ticker" | "timeframe";

interface GoDeeper {
  status: "idle" | "loading" | "ok" | "error";
  answer?: string;
  error?: string;
}

function buildSignalPrompt(sig: SignalPayload): string {
  return [
    `=== REAL DATA: ${sig.ticker} signal ===`,
    `Direction: ${sig.direction} | Confidence: ${sig.confidence} | Timeframe: ${sig.timeframe}`,
    `Title: ${sig.title}`,
    `Explanation: ${sig.explanation}`,
    `Indicators: ${sig.indicators.join(", ") || "none"}`,
    `Generated: ${sig.generatedAt}`,
    ``,
    `Using ONLY the exact data above, provide a 1–5 day trade framing for ${sig.ticker}.`,
    `Cover: entry thesis, key risk, invalidation level, and how the indicators confirm the signal. (~150 words)`,
  ].join("\n");
}

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function SignalsClient({ signals }: Props) {
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<Direction>("all");
  const [sort, setSort] = useState<SortKey>("confidence");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [goDeeper, setGoDeeper] = useState<Record<string, GoDeeper>>({});

  // Load saved filter once on mount; suppress the save effect until after load.
  const [filterReady, setFilterReady] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("signals-filter");
    if (saved) {
      try {
        const { direction: d, sort: s } = JSON.parse(saved) as { direction: Direction; sort: SortKey };
        if (d) setDirection(d);
        if (s) setSort(s);
      } catch { /* ignore */ }
    }
    setFilterReady(true);
  }, []);

  useEffect(() => {
    if (!filterReady) return;
    localStorage.setItem("signals-filter", JSON.stringify({ direction, sort }));
  }, [direction, sort, filterReady]);

  const filtered = useMemo(() => {
    let list = signals;
    if (direction !== "all") list = list.filter(s => s.direction === direction);
    const q = search.trim().toLowerCase();
    if (q) list = list.filter(s => s.ticker.toLowerCase().includes(q) || s.title.toLowerCase().includes(q));
    list = [...list].sort((a, b) => {
      if (sort === "confidence") return (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
      if (sort === "ticker") return a.ticker.localeCompare(b.ticker);
      return 0;
    });
    return list;
  }, [signals, search, direction, sort]);

  async function handleGoDeeper(sig: SignalPayload) {
    if (goDeeper[sig.id]?.status === "loading") return;
    setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "loading" } }));
    try {
      const res = await fetch("/api/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: buildSignalPrompt(sig), seat: "T1" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data?.error === "upgrade_required" ? "Pro feature — upgrade to use Go Deeper." : `Error ${res.status}`;
        setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "error", error: msg } }));
        return;
      }
      const data = await res.json();
      const answer = data.answer ?? "";
      if (!answer) {
        setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "error", error: "Council returned an empty response — try again." } }));
        return;
      }
      setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "ok", answer } }));
    } catch (err) {
      setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "error", error: err instanceof Error ? err.message : "Failed" } }));
    }
  }

  return (
    <div>
      <div className="signals-controls">
        <input
          className="signals-search"
          type="search"
          placeholder="Search ticker or title…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="signals-filters">
          {(["all", "bullish", "bearish", "neutral"] as Direction[]).map(d => (
            <button
              key={d}
              className={`signals-filter-btn${direction === d ? " signals-filter-btn--active" : ""}`}
              onClick={() => setDirection(d)}
            >
              {d === "all" ? "All" : d === "bullish" ? "↑ Bullish" : d === "bearish" ? "↓ Bearish" : "→ Neutral"}
            </button>
          ))}
        </div>
        <select
          className="signals-sort"
          value={sort}
          onChange={e => setSort(e.target.value as SortKey)}
        >
          <option value="confidence">Sort: Confidence</option>
          <option value="ticker">Sort: Ticker A–Z</option>
        </select>
      </div>

      {filtered.length === 0 && (
        <p className="signals-no-results">No signals match your filters.</p>
      )}

      <div className="signals-list">
        {filtered.map(sig => {
          const isExpanded = expandedId === sig.id;
          const deeper = goDeeper[sig.id];
          return (
            <div key={sig.id} id={`signal-${sig.id}`} className={`signal-card${isExpanded ? " signal-card--expanded" : ""}`}>
              <div className="signal-card-header">
                <div>
                  <span className="signal-ticker">{sig.ticker}</span>
                  <span className={`signal-direction signal-direction--${sig.direction}`}>
                    {sig.direction === "bullish" ? "↑" : sig.direction === "bearish" ? "↓" : "→"}{" "}
                    {sig.direction}
                  </span>
                </div>
                <div className="signal-card-actions">
                  <SignalShareButton signal={sig} />
                  <button
                    className="signals-expand-btn"
                    onClick={() => setExpandedId(isExpanded ? null : sig.id)}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? "Close ↑" : "Details ↓"}
                  </button>
                </div>
              </div>
              {sig.isStale ? (
                <p className="signal-stale-badge">
                  ⚠ {sig.dataQualityScore === 'unknown' ? 'Data freshness unknown' : 'Stale data'} — last updated {sig.generatedAt}
                </p>
              ) : (
                <p className="signal-meta">{sig.timeframe} · {sig.confidence} confidence</p>
              )}
              <p className="signal-title">{sig.title}</p>

              {isExpanded && (
                <div className="signal-detail">
                  <p className="signal-explanation">{sig.explanation}</p>
                  {(sig.score != null || sig.signalCounts) && (
                    <p className="signal-score">
                      {sig.score != null && <>Confluence score: {sig.score.toFixed(2)}</>}
                      {sig.signalCounts && (
                        <>
                          {sig.score != null ? " (" : ""}
                          {sig.signalCounts.bullish} bullish / {sig.signalCounts.bearish} bearish of {sig.signalCounts.total}
                          {sig.score != null ? ")" : ""}
                        </>
                      )}
                    </p>
                  )}
                  {sig.reasons && sig.reasons.length > 0 && (
                    <ul className="signal-reasons">
                      {sig.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {sig.indicators.length > 0 && (
                    <div className="signal-indicators">
                      {sig.indicators.map(ind => (
                        <span key={ind} className="signal-chip">{ind}</span>
                      ))}
                    </div>
                  )}
                  {sig.engineVersion && (
                    <p className="signal-provenance">Source: {sig.engineVersion} · {sig.generatedAt}</p>
                  )}

                  <div className="signal-deeper">
                    {(!deeper || deeper.status === "idle") && (
                      <button className="signal-deeper-btn" onClick={() => handleGoDeeper(sig)}>
                        ✦ Go deeper — T1 Council analysis
                      </button>
                    )}
                    {deeper?.status === "loading" && (
                      <p className="signal-deeper-loading">Council is analyzing {sig.ticker}…</p>
                    )}
                    {deeper?.status === "ok" && deeper.answer && (
                      <div className="signal-deeper-result">
                        <p className="signal-deeper-label">T1 Council · 1–5 day framing</p>
                        <p className="signal-deeper-answer">{deeper.answer}</p>
                      </div>
                    )}
                    {deeper?.status === "error" && (
                      <div>
                        <p className="signal-deeper-error">{deeper.error}</p>
                        <button
                          className="signal-deeper-btn"
                          style={{ marginTop: "6px" }}
                          onClick={() => handleGoDeeper(sig)}
                        >
                          ↺ Retry
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
