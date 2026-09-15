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
import type { PaperAccount } from "@/lib/shared/paper-policy";
import {
  computeAccountMetrics,
  type AccountMetrics,
  type MetricsNavPoint,
  type MetricsOrder,
} from "@/lib/shared/paper-metrics-core";

const ROLLING_TURNOVER_WINDOW = 20;

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
