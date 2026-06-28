"use client";
import { useState } from "react";
import type { WatchlistItem } from "@/lib/portfolio";

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

async function consumeStream(
  res: Response,
  onChunk: (accumulated: string) => void,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let accumulated = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed?.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          accumulated += delta;
          onChunk(accumulated);
        }
      } catch { /* skip */ }
    }
  }
}

export function PortfolioClient({ initialWatchlist, gainers, losers }: Props) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(initialWatchlist);
  const [tickerInput, setTickerInput] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  const [healthStatus, setHealthStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [healthText, setHealthText] = useState("");
  const [healthError, setHealthError] = useState("");

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
      if (contentType.includes("text/event-stream")) {
        await consumeStream(res, text => setHealthText(text));
        setHealthStatus("ok");
      } else {
        const data = await res.json();
        setHealthText(data.answer ?? "");
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
                <button className="port-watch-remove" onClick={() => removeTicker(item.ticker)}>✕</button>
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
