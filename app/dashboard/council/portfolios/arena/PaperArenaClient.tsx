"use client";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  JUDGE_COLUMNS,
  type ArenaRowVM,
  type ArenaVM,
  type CurvePointVM,
  type JudgeKey,
} from "@/lib/shared/paper-arena-view";
import type { PaperAccount } from "@/lib/shared/paper-policy";

const ACCOUNT_COLORS: Record<PaperAccount, string> = {
  t1: "#ef4444",
  t2: "#f59e0b",
  risk: "#10b981",
  macro: "#06b6d4",
  quant: "#6366f1",
  chair: "#d946ef",
  equal: "#9ca3af",
  spy: "#e5e7eb",
};

function fmtPct(v: number | null, digits = 1): string {
  if (v == null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
function fmtNum(v: number | null, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}
function fmtUsd(v: number | null): string {
  return v == null ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function signClass(v: number | null): string {
  return v == null ? "" : v > 0 ? "pp-pos" : v < 0 ? "pp-neg" : "";
}

type SortKey = "judgeRank" | JudgeKey | "dayReturnPct" | "annualizedVolPct" | "turnoverPct" | "avgHoldingPeriodDays" | "nav";

function EquityChart({ curves, visible }: { curves: ArenaVM["curves"]; visible: Set<PaperAccount> }) {
  const series = (Object.entries(curves) as [PaperAccount, CurvePointVM[]][]).filter(
    ([a, pts]) => visible.has(a) && pts.length >= 2,
  );
  if (series.length === 0) return <p className="pp-empty">Not enough NAV history to chart yet.</p>;

  const width = 720;
  const height = 240;
  const pad = 8;
  const dates = [...new Set(series.flatMap(([, pts]) => pts.map((p) => p.date)))].sort();
  const xOf = (d: string) => pad + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (width - pad * 2);
  const all = series.flatMap(([, pts]) => pts.map((p) => p.indexed));
  const lo = Math.min(...all, 100);
  const hi = Math.max(...all, 100);
  const span = hi - lo || 1;
  const yOf = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="pa-chart" role="img" aria-label="Equity curves rebased to 100">
      <line x1={pad} x2={width - pad} y1={yOf(100)} y2={yOf(100)} className="pa-baseline" />
      {series.map(([account, pts]) => (
        <polyline
          key={account}
          fill="none"
          stroke={ACCOUNT_COLORS[account]}
          strokeWidth={account === "spy" || account === "equal" ? 1.5 : 2.25}
          strokeDasharray={account === "spy" || account === "equal" ? "5 4" : undefined}
          points={pts.map((p) => `${xOf(p.date).toFixed(1)},${yOf(p.indexed).toFixed(1)}`).join(" ")}
        />
      ))}
      <text x={pad} y={12} className="pa-axis">{hi.toFixed(1)}</text>
      <text x={pad} y={height - 2} className="pa-axis">{lo.toFixed(1)}</text>
    </svg>
  );
}

function MetricsTable({
  rows,
  selected,
  onSelect,
}: {
  rows: ArenaRowVM[];
  selected: PaperAccount | null;
  onSelect: (a: PaperAccount) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("judgeRank");
  const [desc, setDesc] = useState(false);

  const sorted = useMemo(() => {
    const dir = desc ? -1 : 1;
    return [...rows].sort((a, b) => {
      if (a.isBaseline !== b.isBaseline) return a.isBaseline ? 1 : -1;
      const av = a[sortKey] as number | null;
      const bv = b[sortKey] as number | null;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    });
  }, [rows, sortKey, desc]);

  function head(key: SortKey, label: string, hint?: string) {
    const active = sortKey === key;
    return (
      <button
        type="button"
        className={`pa-th${active ? " pa-th--active" : ""}`}
        title={hint}
        onClick={() => {
          if (active) setDesc(!desc);
          else {
            setSortKey(key);
            // Rank is best-first ascending; every metric is best-first descending.
            setDesc(key !== "judgeRank" && key !== "annualizedVolPct" && key !== "turnoverPct");
          }
        }}
      >
        {label}
        {active ? (desc ? " ▼" : " ▲") : ""}
      </button>
    );
  }

  return (
    <div className="pa-scroll">
      <table className="pa-table">
        <thead>
          <tr>
            <th>{head("judgeRank", "Rank", "Mean rank across Return, Sharpe, Max DD, Hit rate and vs SPY. Baselines are yardsticks and aren't ranked.")}</th>
            <th>Account</th>
            <th>{head("nav", "NAV")}</th>
            {JUDGE_COLUMNS.map((c) => (
              <th key={c.key}>{head(c.key, c.label, c.hint)}</th>
            ))}
            <th>{head("dayReturnPct", "Day")}</th>
            <th>{head("annualizedVolPct", "Vol", "Annualized volatility — lower is calmer.")}</th>
            <th>{head("turnoverPct", "Turnover", "Mean order notional per run, as a share of NAV.")}</th>
            <th>{head("avgHoldingPeriodDays", "Hold (d)", "Average holding period of closed positions.")}</th>
            <th title="Average win / average loss">Payoff</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.account}
              className={`pa-row${selected === r.account ? " pa-row--selected" : ""}${r.isBaseline ? " pa-row--baseline" : ""}`}
              onClick={() => onSelect(r.account)}
            >
              <td>{r.isBaseline ? "base" : r.judgeRank != null ? `#${r.judgeRank}` : "—"}</td>
              <td>
                <span className="pa-dot" style={{ background: ACCOUNT_COLORS[r.account] }} aria-hidden />
                <button type="button" className="pa-th" aria-label={`Select ${r.label} account`} aria-pressed={selected === r.account}><strong>{r.label}</strong></button> <span className="pp-seat">{r.seat ?? "control"}</span>
              </td>
              <td>{fmtUsd(r.nav)}</td>
              {JUDGE_COLUMNS.map((c) => {
                const v = r[c.key];
                const isPct = c.key !== "sharpeRf0";
                return (
                  <td key={c.key} className={`${signClass(c.key === "hitRatePct" ? null : v)}${r.bestIn.includes(c.key) ? " pa-best" : ""}`}>
                    {isPct ? fmtPct(v, c.key === "hitRatePct" ? 0 : 1) : fmtNum(v)}
                    {c.key === "hitRatePct" && r.closedPositions > 0 ? <span className="pa-n"> ({r.closedPositions})</span> : null}
                  </td>
                );
              })}
              <td className={signClass(r.dayReturnPct)}>{fmtPct(r.dayReturnPct)}</td>
              <td>{fmtPct(r.annualizedVolPct)}</td>
              <td>{fmtPct(r.turnoverPct)}</td>
              <td>{fmtNum(r.avgHoldingPeriodDays, 1)}</td>
              <td>{fmtNum(r.payoffRatio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradeFeed({ data, selected }: { data: ArenaVM; selected: PaperAccount | null }) {
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const [reason, setReason] = useState<string>("all");
  const [scope, setScope] = useState<"all" | "selected">(selected ? "selected" : "all");
  const [open, setOpen] = useState<string | null>(null);

  const reasons = useMemo(() => [...new Set(data.trades.map((t) => t.reason))].sort(), [data.trades]);
  const trades = data.trades.filter(
    (t) =>
      (side === "all" || t.side === side) &&
      (reason === "all" || t.reason === reason) &&
      (scope === "all" || !selected || t.account === selected),
  );
  const breakdown = selected ? data.reasonBreakdown[selected] ?? [] : [];

  return (
    <section>
      <h2 className="pp-section-title">What they traded, and why</h2>

      {selected && breakdown.length > 0 && (
        <div className="pa-breakdown" aria-label={`Why ${selected} trades`}>
          {breakdown.map((b) => (
            <div key={b.reason} className="pa-chip" title={b.reasonText}>
              <strong>{b.reason}</strong> ×{b.count}
              {b.realizedPnl !== 0 && <span className={signClass(b.realizedPnl)}> {fmtUsd(b.realizedPnl)}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="pa-filters">
        <label>
          Side{" "}
          <select value={side} onChange={(e) => setSide(e.target.value as typeof side)}>
            <option value="all">all</option>
            <option value="buy">buy</option>
            <option value="sell">sell</option>
          </select>
        </label>
        <label>
          Reason{" "}
          <select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="all">all</option>
            {reasons.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        {selected && (
          <label>
            Accounts{" "}
            <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="selected">{selected} only</option>
              <option value="all">all eight</option>
            </select>
          </label>
        )}
        <span className="pa-n">{trades.length} trades</span>
      </div>

      <div className="pa-scroll">
        <table className="pa-table pa-trades">
          <thead>
            <tr>
              <th>When</th><th>Account</th><th>Side</th><th>Ticker</th><th>Fill</th>
              <th>Notional</th><th>Realized</th><th>Why</th><th>Decided by</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <Fragment key={t.id}>
                <tr className="pa-row" onClick={() => setOpen(open === t.id ? null : t.id)}>
                  <td>{new Date(t.when).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td><span className="pa-dot" style={{ background: ACCOUNT_COLORS[t.account] }} aria-hidden />{t.account}</td>
                  <td className={t.side === "buy" ? "pp-pos" : "pp-neg"}>{t.side}</td>
                  <td><button type="button" className="pa-th" aria-label={`Trade details: ${t.account} ${t.side} ${t.ticker} at ${t.when}`} aria-expanded={open === t.id}><strong>{t.ticker}</strong></button></td>
                  <td>${t.fillPrice.toFixed(2)}</td>
                  <td>{fmtUsd(t.notional)}</td>
                  <td className={signClass(t.realizedPnl)}>{t.realizedPnl == null ? "—" : fmtUsd(t.realizedPnl)}</td>
                  <td>{t.reason}</td>
                  <td>{t.decidedBy}{t.model ? ` (${t.model})` : ""}</td>
                </tr>
                {open === t.id && (
                  <tr className="pa-why">
                    <td colSpan={9}>
                      <p>{t.reasonText}.</p>
                      <p className="pa-n">
                        {t.quantity.toFixed(2)} sh · card score {t.cardScore == null ? "—" : t.cardScore.toFixed(1)}
                        {t.thesis ? ` · thesis: ${t.thesis}` : ""}
                      </p>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {trades.length === 0 && <p className="pp-empty">No trades match.</p>}
      </div>
    </section>
  );
}

export function PaperArenaClient({ initial }: { initial: ArenaVM | null }) {
  const [data, setData] = useState<ArenaVM | null>(initial);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<PaperAccount | null>(null);
  const [hidden, setHidden] = useState<Set<PaperAccount>>(new Set());

  useEffect(() => {
    if (initial) return;
    fetch("/api/paper/arena")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch(() => setFailed(true));
  }, [initial]);

  if (!data) return <p className="pp-loading">{failed ? "Paper arena is unavailable right now." : "Loading…"}</p>;
  if (data.rows.length === 0) return <p className="pp-empty">No accounts seeded yet.</p>;

  const visible = new Set(data.rows.map((r) => r.account).filter((a) => !hidden.has(a)));
  const toggle = (a: PaperAccount) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });

  return (
    <div className="pa-stack">
      <section>
        <h2 className="pp-section-title">Judged on five metrics</h2>
        <p className="pa-note">
          Rank is the mean of each account&apos;s rank on Return, Sharpe, Max drawdown, Hit rate and vs-SPY — so a
          lucky single-metric spike doesn&apos;t win. Gold cells mark the best in a column. Click a row to scope the trade feed.
        </p>
        <MetricsTable rows={data.rows} selected={selected} onSelect={(a) => setSelected(selected === a ? null : a)} />
      </section>

      <section>
        <h2 className="pp-section-title">Equity curves (rebased to 100)</h2>
        <div className="pa-legend">
          {data.rows.map((r) => (
            <button
              type="button"
              key={r.account}
              className={`pa-legend-item${hidden.has(r.account) ? " pa-legend-item--off" : ""}`}
              onClick={() => toggle(r.account)}
              aria-pressed={!hidden.has(r.account)}
            >
              <span className="pa-dot" style={{ background: ACCOUNT_COLORS[r.account] }} aria-hidden />
              {r.account}
            </button>
          ))}
        </div>
        <EquityChart curves={data.curves} visible={visible} />
      </section>

      <TradeFeed key={selected ?? "all"} data={data} selected={selected} />
    </div>
  );
}
