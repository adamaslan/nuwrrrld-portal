"use client";
import { useState } from "react";

interface Props {
  ticker: string;
}

interface TradePlan {
  entry?: number;
  stop?: number;
  target?: number;
  risk_reward?: number;
}

interface AnalyzeResult {
  verdict?: string;
  confidence?: number;
  trade_plan?: TradePlan;
  fibonacci?: { levels?: Record<string, number> };
  [key: string]: unknown;
}

const PERIODS = ["1mo", "3mo", "6mo", "1y"];
const RISK_PROFILES = ["conservative", "moderate", "aggressive"];

/**
 * Live per-ticker analysis, wired to POST /api/analyze (holdemfoldem-api via
 * MCP_ANALYZE_URL). Hero path is zero-input: the ticker is already known from
 * the route, so a single button runs a default analysis. Period/risk-profile/
 * position are progressive disclosure behind an "Advanced" toggle, mirroring
 * holdfold's own "Add existing position (optional)" pattern.
 */
export function AnalyzeLivePanel({ ticker }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [period, setPeriod] = useState("3mo");
  const [riskProfile, setRiskProfile] = useState("moderate");
  const [positionQty, setPositionQty] = useState("");
  const [positionEntry, setPositionEntry] = useState("");

  async function runAnalysis() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: ticker,
          period,
          risk_profile: riskProfile,
          position_qty: positionQty ? Number(positionQty) : null,
          position_entry: positionEntry ? Number(positionEntry) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `Analysis failed (${res.status})`);
        return;
      }
      setResult(data);
    } catch (err) {
      setError(`Request failed: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="hf-live-panel">
      <p className="hf-section-label">LIVE TRADE PLAN</p>

      {!result && (
        <button onClick={runAnalysis} disabled={loading} className="hf-live-run-btn">
          {loading ? "Analyzing…" : `Run live analysis for ${ticker}`}
        </button>
      )}

      {!result && (
        <button
          type="button"
          onClick={() => setAdvancedOpen(o => !o)}
          className="hf-live-advanced-toggle"
        >
          {advancedOpen ? "▾ Hide advanced" : "▸ Advanced (period, risk, position)"}
        </button>
      )}

      {advancedOpen && !result && (
        <div className="hf-live-advanced">
          <label>
            Period
            <select value={period} onChange={e => setPeriod(e.target.value)}>
              {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>
            Risk profile
            <select value={riskProfile} onChange={e => setRiskProfile(e.target.value)}>
              {RISK_PROFILES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label>
            Existing position — qty (optional)
            <input type="number" value={positionQty} onChange={e => setPositionQty(e.target.value)} />
          </label>
          <label>
            Existing position — entry price (optional)
            <input type="number" value={positionEntry} onChange={e => setPositionEntry(e.target.value)} />
          </label>
        </div>
      )}

      {error && <p className="hf-live-error">{error}</p>}

      {result && (
        <div className="hf-live-result">
          <div className="hf-ind-grid">
            <div className="hf-ind-cell"><span className="hf-ind-label">VERDICT</span><span className="hf-ind-val">{result.verdict ?? "—"}</span></div>
            <div className="hf-ind-cell"><span className="hf-ind-label">CONFIDENCE</span><span className="hf-ind-val">{result.confidence ?? "—"}</span></div>
          </div>
          {result.trade_plan && (
            <div className="hf-ind-grid">
              <div className="hf-ind-cell"><span className="hf-ind-label">ENTRY</span><span className="hf-ind-val">{result.trade_plan.entry ?? "—"}</span></div>
              <div className="hf-ind-cell"><span className="hf-ind-label">STOP</span><span className="hf-ind-val">{result.trade_plan.stop ?? "—"}</span></div>
              <div className="hf-ind-cell"><span className="hf-ind-label">TARGET</span><span className="hf-ind-val">{result.trade_plan.target ?? "—"}</span></div>
              <div className="hf-ind-cell"><span className="hf-ind-label">R:R</span><span className="hf-ind-val">{result.trade_plan.risk_reward ?? "—"}</span></div>
            </div>
          )}
          <button onClick={() => { setResult(null); setError(null); }} className="hf-live-advanced-toggle">
            Run again
          </button>
        </div>
      )}
    </div>
  );
}
