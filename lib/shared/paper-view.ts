/**
 * paper-view — pure view-model builders for the paper-portfolio leaderboard
 * and per-account drilldown (docs/council-paper-portfolios.md §6, Phase 7 of
 * docs/paper-portfolios-remaining-todo.md).
 *
 * No DB, no React — same split as lib/shared/followed-tickers-view.ts: the
 * server page and every `/api/paper/*` route assemble their JSON from raw DB
 * rows and call into this module, so the two surfaces can't drift on what
 * "the leaderboard" means.
 *
 * `AccountMetrics` below is a locally-owned, structural duck-type of
 * `paper_runs.detail.metrics` — deliberately NOT imported from
 * lib/shared/paper-metrics-core.ts (Phase 8), so this module (Phase 7) has no
 * hard dependency on that phase's code existing and the two branches can
 * merge in either order. `run.detail.metrics` is `unknown` to Postgres either
 * way (a jsonb column); a run that predates Phase 8, or whose metrics
 * computation failed, is simply `null` here and every field renders as "—".
 * Once both phases are merged the real shape is a strict superset of this
 * one, so nothing needs reconciling.
 */
import type { Account, NavPoint, OrderRow, Position, WatchlistEntry } from "@/lib/paper-db";
import type { PaperAccount } from "@/lib/shared/paper-policy";

export interface AccountMetrics {
  totalReturn: number | null;
  dayReturn: number | null;
  cagr: number | null;
  annualizedVol: number | null;
  sharpeRf0: number | null;
  maxDrawdown: number | null;
  currentDrawdown: number | null;
  closedPositions: number;
  hitRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  rollingTurnover: number | null;
  avgHoldingPeriodDays: number | null;
  activeReturnVsSpy: number | null;
  activeReturnVsEqual: number | null;
}

export interface LeaderboardRowVM {
  account: PaperAccount;
  seat: string | null;
  label: string;
  nav: number;
  cash: number;
  totalReturnPct: number | null;
  dayReturnPct: number | null;
  positionsN: number;
  sharpeRf0: number | null;
  maxDrawdownPct: number | null;
  hitRatePct: number | null;
  activeReturnVsSpyPct: number | null;
  activeReturnVsEqualPct: number | null;
  lastRunAt: string;
  lastRunStatus: string;
}

export interface LeaderboardVM {
  rows: LeaderboardRowVM[];
  generatedAt: string;
}

/** One row per account, sorted best-to-worst total return (nulls last —
 *  an account with no runs yet has nothing to rank on). `latestNavByAccount`
 *  is each account's most recent `paper_nav` row (any slot) — NAV and
 *  positions-count come from there (already computed by the engine at run
 *  time, §4.2 step 9) rather than being re-derived from `paper_accounts.cash`
 *  alone, which excludes positions' market value entirely. */
export function buildLeaderboardView(
  accounts: Account[],
  metricsByAccount: ReadonlyMap<PaperAccount, AccountMetrics | null>,
  latestNavByAccount: ReadonlyMap<PaperAccount, NavPoint | null>,
): LeaderboardVM {
  const rows: LeaderboardRowVM[] = accounts.map((a) => {
    const m = metricsByAccount.get(a.account) ?? null;
    const latestNav = latestNavByAccount.get(a.account) ?? null;
    return {
      account: a.account,
      seat: a.seat,
      label: a.label,
      nav: latestNav?.nav ?? a.cash, // no run yet — cash is the only real number available
      cash: a.cash,
      totalReturnPct: (latestNav?.totalReturn ?? m?.totalReturn) != null ? (latestNav?.totalReturn ?? m!.totalReturn)! * 100 : null,
      dayReturnPct: latestNav?.dayReturn != null ? latestNav.dayReturn * 100 : null,
      positionsN: latestNav?.positionsN ?? 0,
      sharpeRf0: m?.sharpeRf0 ?? null,
      maxDrawdownPct: m?.maxDrawdown != null ? m.maxDrawdown * 100 : null,
      hitRatePct: m?.hitRate != null ? m.hitRate * 100 : null,
      activeReturnVsSpyPct: m?.activeReturnVsSpy != null ? m.activeReturnVsSpy * 100 : null,
      activeReturnVsEqualPct: m?.activeReturnVsEqual != null ? m.activeReturnVsEqual * 100 : null,
      lastRunAt: a.updatedAt,
      lastRunStatus: "unknown",
    };
  });
  rows.sort((a, b) => {
    if (a.totalReturnPct == null) return 1;
    if (b.totalReturnPct == null) return -1;
    return b.totalReturnPct - a.totalReturnPct;
  });
  return { rows, generatedAt: new Date().toISOString() };
}

export interface PositionVM {
  ticker: string;
  quantity: number;
  avgCost: number;
  lastPrice: number | null;
  marketValue: number | null;
  weightPct: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  runsHeld: number;
  thesis: string | null;
}

export interface AccountDetailVM {
  account: PaperAccount;
  seat: string | null;
  label: string;
  cash: number;
  nav: number;
  totalReturnPct: number | null;
  positions: PositionVM[];
  metrics: AccountMetrics | null;
  recentOrders: OrderRow[];
  policyVersion: string;
  seededOn: string;
}

/** One account's full book — positions priced with whatever reference price
 *  the caller has (a ticker with no live price shows null market value/weight
 *  rather than falling back to avg cost, so a stale render is visibly stale). */
export function buildAccountDetailView(
  account: Account,
  positions: Position[],
  prices: ReadonlyMap<string, number>,
  metrics: AccountMetrics | null,
  recentOrders: OrderRow[],
): AccountDetailVM {
  const priced = positions.map((p) => {
    const price = prices.get(p.ticker) ?? null;
    const marketValue = price != null ? p.quantity * price : null;
    const unrealizedPnl = price != null ? (price - p.avgCost) * p.quantity : null;
    const unrealizedPnlPct = price != null && p.avgCost > 0 ? price / p.avgCost - 1 : null;
    return { price, marketValue, unrealizedPnl, unrealizedPnlPct };
  });
  const positionsMv = priced.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
  const nav = account.cash + positionsMv;

  const positionVMs: PositionVM[] = positions.map((p, i) => ({
    ticker: p.ticker,
    quantity: p.quantity,
    avgCost: p.avgCost,
    lastPrice: priced[i].price,
    marketValue: priced[i].marketValue,
    weightPct: priced[i].marketValue != null && nav > 0 ? (priced[i].marketValue! / nav) * 100 : null,
    unrealizedPnl: priced[i].unrealizedPnl,
    unrealizedPnlPct: priced[i].unrealizedPnlPct != null ? priced[i].unrealizedPnlPct! * 100 : null,
    runsHeld: p.runsHeld,
    thesis: p.thesis,
  }));
  positionVMs.sort((a, b) => (b.weightPct ?? 0) - (a.weightPct ?? 0));

  return {
    account: account.account,
    seat: account.seat,
    label: account.label,
    cash: account.cash,
    nav,
    totalReturnPct: metrics?.totalReturn != null ? metrics.totalReturn * 100 : null,
    positions: positionVMs,
    metrics,
    recentOrders,
    policyVersion: account.policyVersion,
    seededOn: account.seededOn,
  };
}

export interface WatchlistEntryVM {
  ticker: string;
  inSeedBook: boolean;
  active: boolean;
  dropReason: string | null;
  watchlistVersion: number;
}

export function buildWatchlistView(entries: WatchlistEntry[]): { entries: WatchlistEntryVM[]; version: number | null } {
  const sorted = [...entries].sort((a, b) => a.ticker.localeCompare(b.ticker));
  return {
    entries: sorted.map((w) => ({
      ticker: w.ticker,
      inSeedBook: w.inSeedBook,
      active: w.active,
      dropReason: w.dropReason,
      watchlistVersion: w.watchlistVersion,
    })),
    version: entries[0]?.watchlistVersion ?? null,
  };
}

export interface NavSeriesPointVM {
  tradeDate: string;
  slot: string;
  nav: number;
  totalReturnPct: number | null;
}

export function buildNavSeriesView(points: NavPoint[]): NavSeriesPointVM[] {
  // Callers read newest-first from the DB; charting wants oldest-first.
  return [...points]
    .reverse()
    .map((p) => ({
      tradeDate: p.tradeDate,
      slot: p.slot,
      nav: p.nav,
      totalReturnPct: p.totalReturn != null ? p.totalReturn * 100 : null,
    }));
}
