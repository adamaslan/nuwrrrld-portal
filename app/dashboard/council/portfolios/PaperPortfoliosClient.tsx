"use client";
import { useEffect, useState } from "react";
import type { LeaderboardVM, AccountDetailVM, NavSeriesPointVM } from "@/lib/shared/paper-view";
import type { PaperAccount } from "@/lib/shared/paper-policy";

interface Props {
  initial: LeaderboardVM;
}

function fmtPct(v: number | null, digits = 1): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(digits)}%`;
}

function fmtNum(v: number | null, digits = 2): string {
  return v == null ? "—" : v.toFixed(digits);
}

function returnClass(v: number | null): string {
  if (v == null) return "";
  return v > 0 ? "pp-pos" : v < 0 ? "pp-neg" : "";
}

/** A tiny inline SVG line sparkline — no charting library in this repo (per
 *  docs/paper-portfolios-remaining-todo.md's Phase 7 plan). Renders nothing
 *  useful under 2 points rather than a flat/misleading line. */
function NavSparkline({ series }: { series: NavSeriesPointVM[] }) {
  if (series.length < 2) return <div className="pp-spark-empty">Not enough history yet</div>;

  const width = 320;
  const height = 64;
  const navs = series.map((p) => p.nav);
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  const range = max - min || 1;
  const points = series
    .map((p, i) => {
      const x = (i / (series.length - 1)) * width;
      const y = height - ((p.nav - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = series[series.length - 1];
  const up = last.nav >= series[0].nav;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="pp-spark" role="img" aria-label="NAV history">
      <polyline points={points} fill="none" stroke={up ? "var(--pp-green)" : "var(--pp-red)"} strokeWidth={2} />
    </svg>
  );
}

function AccountDetail({ account }: { account: PaperAccount }) {
  // `data` starts null on every account change (the initializer, not an
  // effect-body setState) so "loading" is derived from data being absent for
  // the *current* account rather than a separate boolean the effect has to
  // remember to flip back off.
  const [data, setData] = useState<{ account: PaperAccount; detail: AccountDetailVM | null; nav: NavSeriesPointVM[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/paper/${account}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/paper/${account}/nav`).then((r) => (r.ok ? r.json() : { series: [] })),
    ]).then(([detailData, navData]) => {
      if (cancelled) return;
      setData({ account, detail: detailData, nav: navData?.series ?? [] });
    });
    return () => {
      cancelled = true;
    };
  }, [account]);

  if (!data || data.account !== account) return <p className="pp-loading">Loading {account}…</p>;
  const { detail, nav } = data;
  if (!detail) return <p className="pp-loading">No data for {account} yet.</p>;

  return (
    <div className="pp-detail">
      <div className="pp-detail-head">
        <h2>{detail.label}</h2>
        <span className="pp-detail-sub">
          {detail.seat ?? "control"} · NAV ${detail.nav.toLocaleString(undefined, { maximumFractionDigits: 0 })} ·{" "}
          <span className={returnClass(detail.totalReturnPct)}>{fmtPct(detail.totalReturnPct)}</span> since inception
        </span>
      </div>

      <NavSparkline series={nav} />

      {detail.metrics && (
        <div className="pp-metrics-grid" role="table" aria-label="Performance metrics">
          <div role="row" className="pp-metric"><span role="cell" className="pp-metric-label">Sharpe (rf=0)</span><span role="cell">{fmtNum(detail.metrics.sharpeRf0)}</span></div>
          <div role="row" className="pp-metric"><span role="cell" className="pp-metric-label">Ann. vol</span><span role="cell">{fmtPct(detail.metrics.annualizedVol != null ? detail.metrics.annualizedVol * 100 : null)}</span></div>
          <div role="row" className="pp-metric"><span role="cell" className="pp-metric-label">Max drawdown</span><span role="cell" className="pp-neg">{fmtPct(detail.metrics.maxDrawdown != null ? detail.metrics.maxDrawdown * 100 : null)}</span></div>
          <div role="row" className="pp-metric"><span role="cell" className="pp-metric-label">Hit rate</span><span role="cell">{fmtPct(detail.metrics.hitRate != null ? detail.metrics.hitRate * 100 : null, 0)} ({detail.metrics.closedPositions})</span></div>
          <div role="row" className="pp-metric"><span role="cell" className="pp-metric-label">vs SPY</span><span role="cell" className={returnClass(detail.metrics.activeReturnVsSpy)}>{fmtPct(detail.metrics.activeReturnVsSpy != null ? detail.metrics.activeReturnVsSpy * 100 : null)}</span></div>
          <div role="row" className="pp-metric"><span role="cell" className="pp-metric-label">vs equal</span><span role="cell" className={returnClass(detail.metrics.activeReturnVsEqual)}>{fmtPct(detail.metrics.activeReturnVsEqual != null ? detail.metrics.activeReturnVsEqual * 100 : null)}</span></div>
        </div>
      )}

      <h3 className="pp-section-title">Positions ({detail.positions.length})</h3>
      <div className="pp-table" role="table" aria-label="Positions">
        <div className="pp-row pp-row--head" role="row">
          <span role="columnheader">Ticker</span>
          <span role="columnheader">Qty</span>
          <span role="columnheader">Avg cost</span>
          <span role="columnheader">Weight</span>
          <span role="columnheader">Unrealized</span>
        </div>
        {detail.positions.map((p) => (
          <div className="pp-row" role="row" key={p.ticker}>
            <span role="cell" data-label="Ticker">{p.ticker}</span>
            <span role="cell" data-label="Qty">{p.quantity.toFixed(2)}</span>
            <span role="cell" data-label="Avg cost">${p.avgCost.toFixed(2)}</span>
            <span role="cell" data-label="Weight">{fmtPct(p.weightPct, 1)}</span>
            <span role="cell" data-label="Unrealized" className={returnClass(p.unrealizedPnlPct)}>
              {fmtPct(p.unrealizedPnlPct)}
            </span>
          </div>
        ))}
        {detail.positions.length === 0 && <p className="pp-empty">No open positions.</p>}
      </div>

      <h3 className="pp-section-title">Recent orders</h3>
      <div className="pp-table" role="table" aria-label="Recent orders">
        <div className="pp-row pp-row--head" role="row">
          <span role="columnheader">When</span>
          <span role="columnheader">Side</span>
          <span role="columnheader">Ticker</span>
          <span role="columnheader">Reason</span>
          <span role="columnheader">Decided by</span>
        </div>
        {detail.recentOrders.map((o) => (
          <div className="pp-row" role="row" key={o.id}>
            <span role="cell" data-label="When">{new Date(o.createdAt).toLocaleDateString()}</span>
            <span role="cell" data-label="Side" className={o.side === "buy" ? "pp-pos" : "pp-neg"}>{o.side}</span>
            <span role="cell" data-label="Ticker">{o.ticker}</span>
            <span role="cell" data-label="Reason">{o.reason}</span>
            <span role="cell" data-label="Decided by">{o.decidedBy}{o.model ? ` (${o.model})` : ""}</span>
          </div>
        ))}
        {detail.recentOrders.length === 0 && <p className="pp-empty">No orders yet.</p>}
      </div>
    </div>
  );
}

export function PaperPortfoliosClient({ initial }: Props) {
  const [leaderboard, setLeaderboard] = useState<LeaderboardVM>(initial);
  const [selected, setSelected] = useState<PaperAccount | null>(null);

  useEffect(() => {
    fetch("/api/paper/accounts")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setLeaderboard(data));
  }, []);

  return (
    <div className="pp-layout">
      <div className="pp-table pp-leaderboard" role="table" aria-label="Leaderboard">
        <div className="pp-row pp-row--head" role="row">
          <span role="columnheader">Account</span>
          <span role="columnheader">NAV</span>
          <span role="columnheader">Total return</span>
          <span role="columnheader">Day</span>
          <span role="columnheader">Sharpe</span>
          <span role="columnheader">Max DD</span>
        </div>
        {leaderboard.rows.map((row) => (
          <button
            key={row.account}
            className={`pp-row pp-row--clickable${selected === row.account ? " pp-row--selected" : ""}`}
            role="row"
            onClick={() => setSelected(row.account)}
          >
            <span role="cell" data-label="Account">
              <strong>{row.label}</strong> <span className="pp-seat">{row.seat ?? "control"}</span>
            </span>
            <span role="cell" data-label="NAV">${row.nav.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            <span role="cell" data-label="Total return" className={returnClass(row.totalReturnPct)}>{fmtPct(row.totalReturnPct)}</span>
            <span role="cell" data-label="Day" className={returnClass(row.dayReturnPct)}>{fmtPct(row.dayReturnPct)}</span>
            <span role="cell" data-label="Sharpe">{fmtNum(row.sharpeRf0)}</span>
            <span role="cell" data-label="Max DD" className="pp-neg">{fmtPct(row.maxDrawdownPct)}</span>
          </button>
        ))}
        {leaderboard.rows.length === 0 && (
          <p className="pp-empty">No accounts seeded yet — see docs/manual-setup-todo.md.</p>
        )}
      </div>

      {selected && <AccountDetail account={selected} />}
    </div>
  );
}
