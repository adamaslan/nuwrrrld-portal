/**
 * paper-metrics — the I/O side of §7 scoring (Phase 8 of
 * docs/paper-portfolios-remaining-todo.md). Reads the settle-slot NAV series,
 * the recent per-run turnover figures, and the full order history for one
 * account, calls into the pure `lib/shared/paper-metrics-core.ts`, and
 * returns the result for `lib/paper-engine.ts` to write into
 * `paper_runs.detail.metrics` at the `settle` slot only (§4.2 step 9 already
 * writes the run row; this module never writes anything itself — the caller
 * owns persistence, same split as paper-firestore-mirror.ts/paper-reconcile.ts).
 *
 * `spy`/`equal`'s own total return is read from their own latest NAV point,
 * not necessarily from *this exact* settle run — `PAPER_ACCOUNTS` runs the
 * six trading accounts before the two controls in one route call (§6), so a
 * trading account's settle metrics would otherwise need to wait on rows that
 * don't exist yet. One run's staleness on a comparison-only figure is a
 * acceptable trade for not reordering the whole route loop over it.
 */
import { getSettleNavSeries, getRecentNavRuns, getOrdersForMetrics, getNavSeries } from "@/lib/paper-db";
import { getArenaNav, getArenaOrders, type NavPoint, type RunRow } from "@/lib/paper-db";
import type { PaperAccount } from "@/lib/shared/paper-policy";
import {
  computeAccountMetrics,
  type AccountMetrics,
  type MetricsNavPoint,
  type MetricsOrder,
} from "@/lib/shared/paper-metrics-core";

const ROLLING_TURNOVER_WINDOW = 20;

/** Reject incomplete/legacy JSON so arena consumers always get the full schema. */
export function readStoredMetrics(value: unknown): AccountMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const nullableKeys = [
    "totalReturn", "dayReturn", "cagr", "annualizedVol", "sharpeRf0",
    "maxDrawdown", "currentDrawdown", "hitRate", "avgWin", "avgLoss",
    "rollingTurnover", "avgHoldingPeriodDays", "activeReturnVsSpy", "activeReturnVsEqual",
  ];
  if (!nullableKeys.every((key) => record[key] === null ||
    (typeof record[key] === "number" && Number.isFinite(record[key])))) return null;
  if (typeof record.closedPositions !== "number" || !Number.isInteger(record.closedPositions) || record.closedPositions < 0) return null;
  return Object.fromEntries([...nullableKeys, "closedPositions"].map((key) => [key, record[key]])) as unknown as AccountMetrics;
}

/**
 * Reuse settle metrics; legacy/missing rows share three bounded fallback reads.
 * Stored scores intentionally stay at the latest settle snapshot until the next
 * settle, including comparison returns captured when that account settled.
 * The arena view still displays latest NAV and its live total/day returns.
 */
export async function loadArenaMetrics(
  accounts: PaperAccount[], latestNav: NavPoint[], runs: RunRow[],
): Promise<Map<PaperAccount, AccountMetrics | null>> {
  const metrics = new Map<PaperAccount, AccountMetrics | null>();
  for (const account of accounts) {
    metrics.set(account, readStoredMetrics(runs.find((run) => run.account === account)?.detail.metrics));
  }
  const missing = accounts.filter((account) => !metrics.get(account));
  if (!missing.length) return metrics;
  const [settleNav, recentRuns, orders] = await Promise.all([
    getArenaNav(missing, 2000, true, false),
    getArenaNav(missing, ROLLING_TURNOVER_WINDOW),
    getArenaOrders(missing, 5000, false),
  ]);
  const spyReturn = latestNav.find((nav) => nav.account === "spy")?.totalReturn ?? null;
  const equalReturn = latestNav.find((nav) => nav.account === "equal")?.totalReturn ?? null;
  for (const account of missing) {
    try {
      const latest = latestNav.find((nav) => nav.account === account);
      metrics.set(account, computeAccountMetrics(
        settleNav.filter((nav) => nav.account === account),
        recentRuns.filter((nav) => nav.account === account).map((nav) => nav.turnover),
        orders.filter((order) => order.account === account),
        latest?.totalReturn ?? null, latest?.dayReturn ?? null,
        account === "spy" ? null : spyReturn,
        account === "equal" ? null : equalReturn,
      ));
    } catch {
      // Match the legacy loader: one failed score must not hide other accounts.
      metrics.set(account, null);
    }
  }
  return metrics;
}

async function latestTotalReturn(account: PaperAccount): Promise<number | null> {
  const [latest] = await getNavSeries(account, 1);
  return latest?.totalReturn ?? null;
}

export async function computeMetricsForAccount(account: PaperAccount): Promise<AccountMetrics> {
  const [settleNavRows, recentRuns, orderRows, latest, spyReturn, equalReturn] = await Promise.all([
    getSettleNavSeries(account),
    getRecentNavRuns(account, ROLLING_TURNOVER_WINDOW),
    getOrdersForMetrics(account),
    getNavSeries(account, 1),
    account === "spy" ? Promise.resolve(null) : latestTotalReturn("spy"),
    account === "equal" ? Promise.resolve(null) : latestTotalReturn("equal"),
  ]);

  const settleNav: MetricsNavPoint[] = settleNavRows.map((n) => ({ tradeDate: n.tradeDate, nav: n.nav }));
  const orders: MetricsOrder[] = orderRows.map((o) => ({
    ticker: o.ticker,
    side: o.side,
    createdAt: o.createdAt,
    realizedPnl: o.realizedPnl,
  }));
  const recentTurnovers = recentRuns.map((n) => n.turnover);
  const latestPoint = latest[0];

  return computeAccountMetrics(
    settleNav,
    recentTurnovers,
    orders,
    latestPoint?.totalReturn ?? null,
    latestPoint?.dayReturn ?? null,
    spyReturn,
    equalReturn,
  );
}
