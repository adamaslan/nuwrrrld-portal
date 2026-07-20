"use client";

import { useState } from "react";
import Link from "next/link";
import type { HoldFoldPayload, HoldFoldVerdict } from "@/app/api/holdfold/route";

interface Props {
  data: HoldFoldPayload;
}

type CouncilSeat = "T1" | "T2";

interface StructuredVerdict {
  outlook: string;
  because: string;
  invalidation: string;
  execution: string;
}

interface CouncilState {
  status: "idle" | "loading" | "ok" | "error";
  verdict?: StructuredVerdict;
  model?: string;
  error?: string;
}

const COUNCIL_ERROR_MESSAGES: Record<string, string> = {
  council_response_invalid:
    "The council's response didn't come back in a usable format — please try again.",
  upgrade_required: "Upgrade to Pro to consult the AI council.",
};

function buildCouncilPrompt(v: HoldFoldVerdict, seat: CouncilSeat): string {
  const fmt = (n: number | null) => (n == null ? "n/a" : n.toFixed(2));
  const topSigs = v.signals.slice(0, 4).map(s => `${s.signal} (${s.strength})`).join("; ");
  const ret = v.returns;

  if (seat === "T1") {
    return [
      `=== REAL DATA: ${v.ticker} ===`,
      `Verdict: ${v.verdict} | Confidence: ${v.confidenceLabel} (${v.confidence}%) | Bias: ${v.bias}`,
      `Industry: ${v.industry}`,
      `Indicators — RSI: ${fmt(v.rsi)}, MACD: ${fmt(v.macd)}, ADX: ${fmt(v.adx)}`,
      `Price: $${v.price > 0 ? v.price.toFixed(2) : "n/a"} | 52W: $${v.low52w.toFixed(2)} – $${v.high52w.toFixed(2)}`,
      `Returns: 1d ${ret["1d"] ?? "n/a"}%, 1w ${ret["1w"] ?? "n/a"}%, 1m ${ret["1m"] ?? "n/a"}%`,
      `Top signals: ${topSigs || "none"}`,
      `AI outlook: ${v.aiOutlook}`,
      ``,
      `Using the EXACT data above, deliver a short-term trading verdict for ${v.ticker}.`,
      `Cover the 1-5 day horizon: outlook, key driver, entry, stop, invalidation. (~150 words)`,
    ].join("\n");
  }

  return [
    `=== REAL DATA: ${v.ticker} ===`,
    `Verdict: ${v.verdict} | Confidence: ${v.confidenceLabel} (${v.confidence}%) | Bias: ${v.bias}`,
    `Industry: ${v.industry}`,
    `Returns: 1m ${ret["1m"] ?? "n/a"}%, 3m ${ret["3m"] ?? "n/a"}%, 1y ${ret["1y"] ?? "n/a"}%`,
    `52W range: $${v.low52w.toFixed(2)} – $${v.high52w.toFixed(2)}`,
    `AI outlook: ${v.aiOutlook}`,
    ``,
    `Using the EXACT data above, deliver a long-term investment thesis for ${v.ticker}.`,
    `Cover the 3–12 month horizon: secular thesis, key catalyst, risk/reward, invalidation. (~150 words)`,
  ].join("\n");
}

function StrengthBadge({ strength }: { strength: string }) {
  const s = strength.toUpperCase();
  const cls =
    s === "BULLISH" ? "hf-sig-badge hf-sig-badge--bull" :
    s === "BEARISH" ? "hf-sig-badge hf-sig-badge--bear" :
    "hf-sig-badge hf-sig-badge--neutral";
  return <span className={cls}>{strength}</span>;
}

function CouncilSeatPanel({
  seat,
  label,
  v,
}: {
  seat: CouncilSeat;
  label: string;
  v: HoldFoldVerdict;
}) {
  const [council, setCouncil] = useState<CouncilState>({ status: "idle" });

  async function askCouncil() {
    setCouncil({ status: "loading" });
    try {
      const res = await fetch("/api/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: buildCouncilPrompt(v, seat), seat, ticker: v.ticker }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = COUNCIL_ERROR_MESSAGES[data.error] ?? `Council unavailable (HTTP ${res.status}).`;
        setCouncil({ status: "error", error: message });
        return;
      }
      setCouncil({ status: "ok", verdict: data.verdict, model: data.model });
    } catch {
      setCouncil({ status: "error", error: "Network error — council unavailable." });
    }
  }

  return (
    <div className="hf-council-seat-panel">
      <button
        className="hf-seat-btn"
        onClick={askCouncil}
        disabled={council.status === "loading"}
      >
        {council.status === "loading" ? "Consulting…" : council.status === "idle" ? label : `↺ ${label}`}
      </button>

      {council.status === "ok" && council.verdict && (
        <div className="hf-council-answer">
          <p className="hf-council-seat-label">
            {label.toUpperCase()}
            {council.model && <span className="hf-council-model"> · {council.model.split("/").pop()}</span>}
          </p>
          <dl className="hf-council-fields">
            <dt>Outlook</dt><dd>{council.verdict.outlook}</dd>
            <dt>Because</dt><dd>{council.verdict.because}</dd>
            <dt>Invalidation</dt><dd>{council.verdict.invalidation}</dd>
            <dt>Execution</dt><dd>{council.verdict.execution}</dd>
          </dl>
        </div>
      )}

      {council.status === "error" && (
        <p className="hf-council-error">{council.error}</p>
      )}
    </div>
  );
}

function VerdictDetail({ v, onClose }: { v: HoldFoldVerdict; onClose: () => void }) {

  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));
  const verdictCls = v.verdict === "HOLD EM" ? "hf-verdict--hold" : v.verdict === "FOLD EM" ? "hf-verdict--fold" : "hf-verdict--neutral";

  return (
    <div className="hf-detail">
      <div className="hf-detail-header">
        <button className="hf-close" onClick={onClose} aria-label="Close">✕</button>
        <div className="hf-detail-title">
          <span className="hf-detail-ticker">{v.ticker}</span>
          <span className={`hf-verdict-badge ${verdictCls}`}>{v.verdict}</span>
        </div>
        <p className="hf-detail-industry">{v.industry}</p>
      </div>

      <div className="hf-detail-conf">
        <span className="hf-conf-num">{v.confidence}</span>
        <span className="hf-conf-pct">%</span>
        <span className="hf-conf-label">confidence · {v.bias}</span>
      </div>

      <div className="hf-ind-grid">
        <div className="hf-ind-cell"><span className="hf-ind-label">RSI</span><span className="hf-ind-val">{fmt(v.rsi)}</span></div>
        <div className="hf-ind-cell"><span className="hf-ind-label">MACD</span><span className="hf-ind-val">{fmt(v.macd)}</span></div>
        <div className="hf-ind-cell"><span className="hf-ind-label">ADX</span><span className="hf-ind-val">{fmt(v.adx)}</span></div>
        <div className="hf-ind-cell"><span className="hf-ind-label">PRICE</span><span className="hf-ind-val">{v.price > 0 ? `$${v.price.toFixed(2)}` : "—"}</span></div>
      </div>

      {v.signals.length > 0 && (
        <div className="hf-sigs">
          <p className="hf-section-label">TOP SIGNALS</p>
          {v.signals.slice(0, 5).map((sig, i) => (
            <div key={i} className="hf-sig-row">
              <StrengthBadge strength={sig.strength} />
              <span className="hf-sig-text">{sig.signal}</span>
            </div>
          ))}
        </div>
      )}

      {v.aiOutlook && (
        <div className="hf-outlook">
          <p className="hf-section-label">AI OUTLOOK</p>
          <p className="hf-outlook-text">{v.aiOutlook}</p>
        </div>
      )}

      <div className="hf-backtest-link">
        <Link href={`/dashboard/holdfold/${encodeURIComponent(v.ticker)}`} className="hf-back">
          View full ticker page &amp; backtest track record →
        </Link>
      </div>

      <div className="hf-council">
        <p className="hf-section-label">AI COUNCIL — SHORT-TERM &amp; LONG-TERM</p>
        <div className="hf-council-grid">
          <CouncilSeatPanel seat="T1" label="Short-Term (T1)" v={v} />
          <CouncilSeatPanel seat="T2" label="Long-Term (T2)" v={v} />
        </div>
      </div>
    </div>
  );
}

export function HoldFoldClient({ data }: Props) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<HoldFoldVerdict | null>(null);
  const [filter, setFilter] = useState<"all" | "HOLD EM" | "FOLD EM" | "NEUTRAL">("all");

  const filtered = data.verdicts.filter(v => {
    const matchesSearch = !search || v.ticker.includes(search.toUpperCase()) || v.industry.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all" || v.verdict === filter;
    return matchesSearch && matchesFilter;
  });

  return (
    <div className="hf-body">
      <div className="hf-controls">
        <input
          className="hf-search"
          type="text"
          placeholder="Search ticker or industry…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="hf-filters">
          {(["all", "HOLD EM", "FOLD EM", "NEUTRAL"] as const).map(f => (
            <button
              key={f}
              className={`hf-filter-btn${filter === f ? " hf-filter-btn--active" : ""}${f === "HOLD EM" ? " hf-filter-btn--hold" : f === "FOLD EM" ? " hf-filter-btn--fold" : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f}
            </button>
          ))}
        </div>
      </div>

      <div className="hf-layout">
        <div className="hf-list">
          {filtered.length === 0 && <p className="hf-no-results">No tickers match your search.</p>}
          {filtered.map(v => {
            const verdictCls = v.verdict === "HOLD EM" ? "hf-row--hold" : v.verdict === "FOLD EM" ? "hf-row--fold" : "hf-row--neutral";
            const isActive = selected?.ticker === v.ticker;
            return (
              <button
                key={v.ticker}
                className={`hf-row ${verdictCls}${isActive ? " hf-row--active" : ""}`}
                onClick={() => setSelected(isActive ? null : v)}
              >
                <span className="hf-row-ticker">{v.ticker}</span>
                <span className="hf-row-industry">{v.industry}</span>
                <span className={`hf-row-verdict ${verdictCls}`}>{v.verdict}</span>
                <span className="hf-row-conf">{v.confidenceLabel}</span>
              </button>
            );
          })}
        </div>

        {selected && (
          <VerdictDetail v={selected} onClose={() => setSelected(null)} />
        )}
      </div>
    </div>
  );
}
