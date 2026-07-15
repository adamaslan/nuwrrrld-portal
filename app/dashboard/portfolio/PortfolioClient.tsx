"use client";
import { useState, useEffect, useCallback } from "react";
import type { WatchlistItem, PortfolioHealth, OptimizerSuggestion } from "@/lib/portfolio";
import { consumeSSE } from "@/lib/shared/sse";

interface SectorEntry {
  name: string;
  changePct: number;
  returns: Record<string, number>;
  aiScore: number | null;
  aiAction: string | null;
}

interface Props {
  initialWatchlist: WatchlistItem[];
  gainers: SectorEntry[];
  losers: SectorEntry[];
}

function SectorRow({ sector }: { sector: SectorEntry }) {
  const [open, setOpen] = useState(false);
  const up = sector.changePct >= 0;
  const action = (sector.aiAction ?? "").toUpperCase();
  const badge =
    action === "BUY" ? "port-sector-badge--buy" :
    action === "SELL" ? "port-sector-badge--sell" :
    "port-sector-badge--hold";
  const badgeLabel = action === "BUY" ? "BUY" : action === "SELL" ? "SELL" : "HOLD";

  return (
    <button
      className={`port-sector-row${open ? " port-sector-row--expanded" : ""}`}
      onClick={() => setOpen(o => !o)}
      aria-expanded={open}
    >
      <div style={{ flex: 1, textAlign: "left" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span className="port-sector-name">{sector.name}</span>
          <span className={`port-sector-change port-sector-change--${up ? "up" : "down"}`}>
            {up ? "+" : ""}{sector.changePct.toFixed(2)}%
          </span>
        </div>
        {open && (
          <div className="port-sector-detail">
            {sector.returns["1w"] != null && (
              <span className="port-sector-stat">1W: <span>{sector.returns["1w"] > 0 ? "+" : ""}{sector.returns["1w"].toFixed(2)}%</span></span>
            )}
            {sector.returns["1m"] != null && (
              <span className="port-sector-stat">1M: <span>{sector.returns["1m"] > 0 ? "+" : ""}{sector.returns["1m"].toFixed(2)}%</span></span>
            )}
            {sector.aiScore != null && (
              <span className="port-sector-stat">AI Score: <span>{sector.aiScore}</span></span>
            )}
            {sector.aiAction && (
              <span className={`port-sector-badge ${badge}`}>{badgeLabel}</span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}


export function PortfolioClient({ initialWatchlist, gainers, losers }: Props) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(initialWatchlist);
  const [tickerInput, setTickerInput] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  const [healthStatus, setHealthStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [healthText, setHealthText] = useState("");
  const [healthError, setHealthError] = useState("");

  // Portfolio Health Score — the numeric score from /api/portfolio/health,
  // distinct from the AI narrative health-ai panel above. Previously fetched
  // by nothing: the audit found this button permanently disabled and the
  // result never rendered.
  const [scoreStatus, setScoreStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [score, setScore] = useState<PortfolioHealth | null>(null);
  const [scoreError, setScoreError] = useState("");

  const runScoreCheck = useCallback(async () => {
    setScoreStatus("loading");
    setScoreError("");
    try {
      const res = await fetch("/api/portfolio/health");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setScoreStatus("error");
        setScoreError(data.error === "MCP_BACKEND_URL not configured"
          ? "Health score backend not configured."
          : "Health score unavailable — try again shortly.");
        return;
      }
      const data = await res.json() as PortfolioHealth;
      setScore(data);
      setScoreStatus("ok");
    } catch {
      setScoreStatus("error");
      setScoreError("Network error — could not load health score.");
    }
  }, []);

  // Portfolio Suggestions — /api/portfolio/suggestions existed but nothing
  // called it from the UI. Fetched alongside the score check.
  const [suggestions, setSuggestions] = useState<OptimizerSuggestion[] | null>(null);
  const [suggestionsStatus, setSuggestionsStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");

  useEffect(() => {
    setSuggestionsStatus("loading");
    fetch("/api/portfolio/suggestions")
      .then(res => res.ok ? res.json() : [])
      .then((data: OptimizerSuggestion[]) => {
        setSuggestions(data);
        setSuggestionsStatus("ok");
      })
      .catch(() => setSuggestionsStatus("error"));
  }, []);

  async function addTicker() {
    const ticker = tickerInput.trim().toUpperCase();
    if (!ticker) return;
    setAdding(true);
    setAddError("");
    try {
      const res = await fetch("/api/portfolio/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      if (res.status === 409) { setAddError(`${ticker} is already in your watchlist.`); return; }
      if (!res.ok) { setAddError("Failed to add ticker."); return; }
      const item = await res.json() as WatchlistItem;
      setWatchlist(w => [...w, item]);
      setTickerInput("");
    } catch {
      setAddError("Network error — could not add ticker.");
    } finally {
      setAdding(false);
    }
  }

  async function removeTicker(ticker: string) {
    const res = await fetch(`/api/portfolio/watchlist/${encodeURIComponent(ticker)}`, { method: "DELETE" });
    if (res.ok) setWatchlist(w => w.filter(i => i.ticker !== ticker));
  }

  async function runHealthCheck() {
    if (healthStatus === "loading") return;
    setHealthStatus("loading");
    setHealthText("");
    setHealthError("");
    try {
      const res = await fetch("/api/portfolio/health-ai", { method: "POST" });
      if (res.status === 403) {
        setHealthStatus("error");
        setHealthError("Pro feature — upgrade to run a health check.");
        return;
      }
      if (!res.ok) {
        setHealthStatus("error");
        setHealthError("Health check unavailable — try again shortly.");
        return;
      }
      const contentType = res.headers.get("content-type") ?? "";
      let finalText = "";
      if (contentType.includes("text/event-stream")) {
        await consumeSSE(res, (_delta, accumulated) => { finalText = accumulated; setHealthText(accumulated); });
      } else {
        const data = await res.json();
        finalText = data.answer ?? "";
        setHealthText(finalText);
      }
      if (!finalText) {
        setHealthStatus("error");
        setHealthError("Health check returned empty — try again.");
      } else {
        setHealthStatus("ok");
      }
    } catch (err) {
      setHealthStatus("error");
      setHealthError(err instanceof Error ? err.message : "Failed.");
    }
  }

  const allSectors = [
    ...gainers.map(s => ({ ...s, type: "gainer" as const })),
    ...losers.map(s => ({ ...s, type: "loser" as const })),
  ];

  return (
    <div className="port-body">
      {/* Watchlist */}
      <div className="port-panel">
        <p className="port-panel-title">Watchlist</p>
        <div className="port-watch-add">
          <input
            className="port-watch-input"
            placeholder="Add ticker (e.g. AAPL)"
            value={tickerInput}
            onChange={e => setTickerInput(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === "Enter") addTicker(); }}
            maxLength={10}
          />
          <button className="port-watch-btn" onClick={addTicker} disabled={adding || !tickerInput.trim()}>
            + Add
          </button>
        </div>
        {addError && <p className="port-watch-error">{addError}</p>}
        {watchlist.length === 0 ? (
          <p className="port-watch-empty">No tickers yet — add one above.</p>
        ) : (
          <div className="port-watch-list">
            {watchlist.map(item => (
              <div key={item.ticker} className="port-watch-item">
                <span className="port-watch-ticker">{item.ticker}</span>
                <span className="port-watch-date">{new Date(item.addedAt).toLocaleDateString()}</span>
                <button className="port-watch-remove" onClick={() => removeTicker(item.ticker)} aria-label={`Remove ${item.ticker} from watchlist`}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Portfolio Health Score — numeric score from /api/portfolio/health */}
      <div className="port-panel">
        <p className="port-panel-title">Portfolio Health Score</p>
        {scoreStatus === "idle" && (
          <button className="port-health-btn" onClick={runScoreCheck}>
            Run health score
          </button>
        )}
        {scoreStatus === "loading" && (
          <button className="port-health-btn" disabled>Analyzing…</button>
        )}
        {scoreStatus === "ok" && score && (
          <div className="port-health-result">
            <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "8px" }}>
              <span style={{ fontSize: "2rem", fontWeight: 900 }}>{score.score}</span>
              <span style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--cyan)" }}>Grade {score.grade}</span>
            </div>
            {score.summary && <p className="port-health-text">{score.summary}</p>}
            {score.factors.length > 0 && (
              <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {score.factors.map(f => (
                  <div key={f.name} style={{ display: "flex", justifyContent: "space-between", fontSize: ".82rem" }}>
                    <span>{f.name}</span>
                    <span className={f.impact === "positive" ? "port-sector-change--up" : f.impact === "negative" ? "port-sector-change--down" : ""}>
                      {f.score}/100
                    </span>
                  </div>
                ))}
              </div>
            )}
            <button className="port-health-regen" onClick={runScoreCheck}>↺ Refresh</button>
          </div>
        )}
        {scoreStatus === "error" && (
          <>
            <p className="port-health-error">{scoreError}</p>
            <button className="port-health-regen" onClick={runScoreCheck}>Try again</button>
          </>
        )}
      </div>

      {/* Portfolio Suggestions — /api/portfolio/suggestions, previously unwired */}
      <div className="port-panel">
        <p className="port-panel-title">Optimizer Suggestions</p>
        {suggestionsStatus === "loading" && (
          <p className="port-health-loading">Loading suggestions…</p>
        )}
        {suggestionsStatus === "error" && (
          <p className="port-health-error">Suggestions unavailable — try again shortly.</p>
        )}
        {suggestionsStatus === "ok" && suggestions && suggestions.length === 0 && (
          <p className="port-watch-empty">No suggestions right now — check back after adding tickers.</p>
        )}
        {suggestionsStatus === "ok" && suggestions && suggestions.length > 0 && (
          <div className="port-watch-list">
            {suggestions.map(s => (
              <div key={s.id} className="port-watch-item" style={{ alignItems: "flex-start", flexDirection: "column", gap: "4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                  <span className="port-watch-ticker">{s.ticker ?? s.title}</span>
                  <span className={`port-sector-badge ${s.priority === "high" ? "port-sector-badge--sell" : s.priority === "low" ? "port-sector-badge--hold" : "port-sector-badge--buy"}`}>
                    {s.priority}
                  </span>
                </div>
                <p style={{ fontSize: ".82rem", color: "var(--muted)", margin: 0 }}>{s.rationale}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI Health Check */}
      <div className="port-panel">
        <p className="port-panel-title">Portfolio Health Check · AI</p>
        {healthStatus === "idle" && (
          <button className="port-health-btn" onClick={runHealthCheck}>
            ✦ Run AI health check
          </button>
        )}
        {healthStatus === "loading" && (
          <>
            <button className="port-health-btn" disabled>Analyzing…</button>
            {healthText ? (
              <div className="port-health-result">
                <p className="port-health-label">Health Check · T2 Council</p>
                <p className="port-health-text">{healthText}</p>
              </div>
            ) : (
              <p className="port-health-loading" style={{ marginTop: "10px" }}>Council is reviewing your portfolio…</p>
            )}
          </>
        )}
        {healthStatus === "ok" && healthText && (
          <div className="port-health-result">
            <p className="port-health-label">Health Check · T2 Council</p>
            <p className="port-health-text">{healthText}</p>
            <button className="port-health-regen" onClick={() => setHealthStatus("idle")}>↺ Run again</button>
          </div>
        )}
        {healthStatus === "error" && (
          <>
            <p className="port-health-error">{healthError}</p>
            <button className="port-health-regen" onClick={() => setHealthStatus("idle")}>Try again</button>
          </>
        )}
      </div>

      {/* Sector Rotation */}
      {allSectors.length > 0 && (
        <div className="port-panel" style={{ gridColumn: "1 / -1" }}>
          <p className="port-panel-title">Sector Rotation · Today</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <p style={{ fontSize: ".72rem", fontWeight: 700, color: "var(--green)", textTransform: "uppercase", marginBottom: "8px" }}>Top Gainers</p>
              <div className="port-sector-list">
                {gainers.map(s => <SectorRow key={s.name} sector={s} />)}
              </div>
            </div>
            <div>
              <p style={{ fontSize: ".72rem", fontWeight: 700, color: "var(--red)", textTransform: "uppercase", marginBottom: "8px" }}>Top Laggards</p>
              <div className="port-sector-list">
                {losers.map(s => <SectorRow key={s.name} sector={s} />)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
