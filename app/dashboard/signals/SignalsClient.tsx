"use client";
import { useState, useMemo, useEffect } from "react";
import type { SignalPayload } from "@/lib/digest";
import { SignalShareButton } from "@/components/SignalShareButton";
import { TrackRecordBadge } from "@/components/TrackRecordBadge";
import { SignalAskAnything } from "@/components/SignalAskAnything";
import { filterSignals, sortSignals, type Direction, type SortKey } from "@/lib/shared/signalFilters";
import { buildSignalPrompt } from "@/lib/shared/prompts";
import { getPref, setPref } from "@/lib/shared/prefs";
import { councilErrorMessage } from "@/lib/shared/councilErrors";
import type { StructuredVerdict } from "@/lib/council-verdict";

const FILTER_PREF_KEY = "signals-filter";

interface Props {
  signals: SignalPayload[];
}

interface GoDeeper {
  status: "idle" | "loading" | "ok" | "error";
  verdict?: StructuredVerdict;
  model?: string;
  error?: string;
}

interface WatchlistAdd {
  status: "idle" | "loading" | "ok" | "error";
  error?: string;
}

export function SignalsClient({ signals }: Props) {
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<Direction>("all");
  const [sort, setSort] = useState<SortKey>("confidence");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [goDeeper, setGoDeeper] = useState<Record<string, GoDeeper>>({});
  const [watchlist, setWatchlist] = useState<Record<string, WatchlistAdd>>({});

  // Load saved filter once on mount; suppress the save effect until after load.
  const [filterReady, setFilterReady] = useState(false);
  useEffect(() => {
    (async () => {
      const saved = await getPref(FILTER_PREF_KEY);
      if (saved) {
        try {
          const { direction: d, sort: s } = JSON.parse(saved) as { direction: Direction; sort: SortKey };
          if (d) setDirection(d);
          if (s) setSort(s);
        } catch { /* ignore */ }
      }
      setFilterReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!filterReady) return;
    setPref(FILTER_PREF_KEY, JSON.stringify({ direction, sort }));
  }, [direction, sort, filterReady]);

  const filtered = useMemo(
    () => sortSignals(filterSignals(signals, search, direction), sort),
    [signals, search, direction, sort],
  );

  async function handleGoDeeper(sig: SignalPayload) {
    if (goDeeper[sig.id]?.status === "loading") return;
    setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "loading" } }));
    try {
      const res = await fetch("/api/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: buildSignalPrompt(sig), seat: "T1", ticker: sig.ticker }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGoDeeper(prev => ({
          ...prev,
          [sig.id]: { status: "error", error: councilErrorMessage(data?.error, res.status) },
        }));
        return;
      }
      // The route responds { verdict, model, seat } — a 200 without a parsed
      // verdict means the contract changed, so surface it rather than render blank.
      if (!data?.verdict) {
        setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "error", error: "Council returned an empty response — try again." } }));
        return;
      }
      setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "ok", verdict: data.verdict, model: data.model } }));
    } catch (err) {
      setGoDeeper(prev => ({ ...prev, [sig.id]: { status: "error", error: err instanceof Error ? err.message : "Failed" } }));
    }
  }

  async function handleAddToWatchlist(ticker: string) {
    if (watchlist[ticker]?.status === "loading" || watchlist[ticker]?.status === "ok") return;
    setWatchlist(prev => ({ ...prev, [ticker]: { status: "loading" } }));
    try {
      const res = await fetch("/api/portfolio/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      if (!res.ok && res.status !== 409) {
        const data = await res.json().catch(() => ({}));
        setWatchlist(prev => ({ ...prev, [ticker]: { status: "error", error: data?.error ?? `Error ${res.status}` } }));
        return;
      }
      // 409 (already in watchlist) is treated as success — the ticker is watched either way.
      setWatchlist(prev => ({ ...prev, [ticker]: { status: "ok" } }));
    } catch {
      setWatchlist(prev => ({ ...prev, [ticker]: { status: "error", error: "Network error" } }));
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
        {filtered.map((sig, idx) => {
          const isExpanded = expandedId === sig.id;
          const deeper = goDeeper[sig.id];
          const isPrimary = idx === 0;
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
                    className="signals-watchlist-btn"
                    onClick={() => handleAddToWatchlist(sig.ticker)}
                    disabled={watchlist[sig.ticker]?.status === "loading" || watchlist[sig.ticker]?.status === "ok"}
                    title={watchlist[sig.ticker]?.status === "error" ? watchlist[sig.ticker]?.error : undefined}
                  >
                    {watchlist[sig.ticker]?.status === "ok" ? "✓ Watching" :
                     watchlist[sig.ticker]?.status === "loading" ? "Adding…" :
                     watchlist[sig.ticker]?.status === "error" ? "↺ Retry" : "+ Watchlist"}
                  </button>
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

                  {isPrimary && (
                    <>
                      <TrackRecordBadge symbol={sig.ticker} strength={sig.confidence} />
                      <SignalAskAnything key={sig.ticker} ticker={sig.ticker} />
                    </>
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
                    {deeper?.status === "ok" && deeper.verdict && (
                      <div className="signal-deeper-result">
                        <p className="signal-deeper-label">
                          T1 Council · 1–5 day framing
                          {deeper.model && <span className="signal-deeper-model"> · {deeper.model.split("/").pop()}</span>}
                        </p>
                        <dl className="signal-deeper-fields">
                          <dt>Outlook</dt><dd>{deeper.verdict.outlook}</dd>
                          <dt>Because</dt><dd>{deeper.verdict.because}</dd>
                          <dt>Invalidation</dt><dd>{deeper.verdict.invalidation}</dd>
                          <dt>Execution</dt><dd>{deeper.verdict.execution}</dd>
                        </dl>
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
