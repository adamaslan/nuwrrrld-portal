/**
 * paper-arena — I/O side of the all-accounts comparison view. Read-only:
 * gathers every account's metrics, NAV marks, orders and open positions and
 * hands them to the pure `buildArenaView`. Shared by the page and
 * `/api/paper/arena` so they can't drift.
 */
import { listAccounts, getArenaNav, getArenaOrders, getArenaPositions, getArenaSettleRuns } from "@/lib/paper-db";
import { loadArenaMetrics } from "@/lib/paper-metrics";
import { PAPER_ACCOUNTS } from "@/lib/shared/paper-policy";
import { buildArenaView, type ArenaVM, type ArenaAccountInput } from "@/lib/shared/paper-arena-view";

const ORDERS_PER_ACCOUNT = 100;
const NAV_POINTS_PER_ACCOUNT = 400;

export async function loadArena(): Promise<ArenaVM> {
  const accounts = (await listAccounts()).filter((a) => PAPER_ACCOUNTS.includes(a.account));
  if (!accounts.length) return buildArenaView([]);
  const keys = accounts.map((a) => a.account);
  const [nav, latestNav, orders, positions, runs] = await Promise.all([
    getArenaNav(keys, NAV_POINTS_PER_ACCOUNT, true),
    // Fallback metrics need control returns even if their account rows are absent.
    getArenaNav([...new Set([...keys, "spy" as const, "equal" as const])], 1),
    getArenaOrders(keys, ORDERS_PER_ACCOUNT),
    getArenaPositions(keys),
    getArenaSettleRuns(keys),
  ]);
  const metrics = await loadArenaMetrics(keys, latestNav, runs);
  const inputs = accounts.map((a): ArenaAccountInput => ({
    account: a.account,
    seat: a.seat,
    label: a.label,
    cash: a.cash,
    metrics: metrics.get(a.account) ?? null,
    nav: nav.filter((point) => point.account === a.account).reverse(),
    latestNav: latestNav.find((point) => point.account === a.account) ?? null,
    orders: orders.filter((order) => order.account === a.account),
    positions: positions.filter((position) => position.account === a.account),
  }));
  return buildArenaView(inputs);
}
