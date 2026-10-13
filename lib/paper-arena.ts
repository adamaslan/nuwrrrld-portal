/**
 * paper-arena — I/O side of the all-accounts comparison view. Read-only:
 * gathers every account's metrics, NAV marks, orders and open positions and
 * hands them to the pure `buildArenaView`. Shared by the page and
 * `/api/paper/arena` so they can't drift.
 */
import { listAccounts, getSettleNavSeries, getNavSeries, listOrders, getPositions } from "@/lib/paper-db";
import { computeMetricsForAccount } from "@/lib/paper-metrics";
import { PAPER_ACCOUNTS } from "@/lib/shared/paper-policy";
import { buildArenaView, type ArenaVM, type ArenaAccountInput } from "@/lib/shared/paper-arena-view";

const ORDERS_PER_ACCOUNT = 100;
const NAV_POINTS_PER_ACCOUNT = 400;

export async function loadArena(): Promise<ArenaVM> {
  const accounts = await listAccounts();
  const inputs = await Promise.all(
    accounts
      .filter((a) => PAPER_ACCOUNTS.includes(a.account))
      .map(async (a): Promise<ArenaAccountInput> => {
        const [metrics, nav, [latestNav], orders, positions] = await Promise.all([
          computeMetricsForAccount(a.account).catch(() => null),
          getSettleNavSeries(a.account, NAV_POINTS_PER_ACCOUNT, true),
          getNavSeries(a.account, 1),
          listOrders(a.account, ORDERS_PER_ACCOUNT),
          getPositions(a.account),
        ]);
        return {
          account: a.account,
          seat: a.seat,
          label: a.label,
          cash: a.cash,
          metrics,
          nav,
          latestNav: latestNav ?? null,
          orders,
          positions,
        };
      }),
  );
  return buildArenaView(inputs);
}
