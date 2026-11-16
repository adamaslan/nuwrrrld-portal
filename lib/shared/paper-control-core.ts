/** Deterministic inception only. Existing cash marks are never backfilled. */
import { fillOrders, type ProposedOrder } from "./paper-engine-core";
export const CONTROL_CORE_50 = [
  // Technology (7)
  "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ACN",
  // Financial Services (6)
  "JPM", "BAC", "BRK.B", "V", "MA", "GS",
  // Healthcare (6)
  "JNJ", "LLY", "ABBV", "UNH", "TMO", "ABT",
  // Consumer Cyclical (5)
  "AMZN", "TSLA", "HD", "MCD", "NKE",
  // Industrials (5)
  "CAT", "HON", "UNP", "GE", "RTX",
  // Communication Services (5)
  "GOOGL", "META", "NFLX", "DIS", "TMUS",
  // Consumer Defensive (5)
  "PG", "KO", "COST", "WMT", "PEP",
  // Energy (4)
  "XOM", "CVX", "COP", "SLB",
  // Utilities (3)
  "NEE", "SO", "DUK",
  // Real Estate (2)
  "PLD", "AMT",
  // Basic Materials (2)
  "LIN", "SHW",
] as const;
export type ControlAccount = "equal" | "spy";
export function controlTickers(account: ControlAccount): readonly string[] { return account === "spy" ? ["IVV"] : CONTROL_CORE_50; }
export type ControlPlan = { ok: true; orders: ProposedOrder[] } | { ok: false; reason: string };
export function planControlInception(account: ControlAccount, cash: number, startingCash: number,
  positionsN: number, ordersN: number, watchlist: ReadonlySet<string>, prices: ReadonlyMap<string, number>): ControlPlan {
  if (positionsN > 0) return { ok: true, orders: [] }; // Never rebalance a live book.
  if (ordersN !== 0) return { ok: false, reason: "control_history_without_positions" };
  if (!Number.isFinite(cash) || !Number.isFinite(startingCash) || startingCash <= 0 || Math.abs(cash - startingCash) > 0.000001)
    return { ok: false, reason: "control_cash_not_pristine" };
  const tickers = controlTickers(account);
  if (watchlist.size !== tickers.length || tickers.some((t) => !watchlist.has(t)))
    return { ok: false, reason: "control_watchlist_incomplete_or_changed" };
  if (tickers.some((t) => !Number.isFinite(prices.get(t)) || prices.get(t)! <= 0))
    return { ok: false, reason: "control_prices_missing_or_stale" };
  const budget = cash / tickers.length;
  const orders = tickers.map((ticker): ProposedOrder => {
    const refPrice = prices.get(ticker)!;
    // Reuse actual fill slippage to keep fractional buys within each allocation.
    const [unit] = fillOrders([{ticker,side:"buy",quantity:1,refPrice,reason:"control_seed"}],new Map());
    const quantity = Math.floor(budget / unit.fillPrice * 1e6) / 1e6;
    return { ticker, side: "buy", quantity, refPrice, reason: "control_seed" };
  });
  if (orders.some((o) => !Number.isFinite(o.quantity) || o.quantity <= 0)) return { ok:false, reason:"control_allocation_too_small" };
  return {ok:true,orders};
}
