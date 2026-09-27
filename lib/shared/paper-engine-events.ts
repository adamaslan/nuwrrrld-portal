/**
 * paper-engine-events — pure decision core for the `engine` paper account
 * (homebase harness/CLOUD-ENGINE.md, Phase 1 step 5b): trade the engine's own
 * default fib hits, long only, and measure what they actually earn before any
 * promotion.
 *
 * Unlike the council accounts this is not score-driven: a position is opened
 * by a hit that carries its own stop (below the golden pocket) and target
 * (the leg high), and closed when price reaches either, when the time exit
 * passes, or when the ticker leaves the watchlist. No model is involved.
 *
 * Pure and DB-free, like paper-engine-core.ts. The I/O shell (loading hits,
 * persisting orders, the run route) is not part of this module.
 */
import { isMegaOrLargeCap, sectorFor } from "./paper-sectors";

export const ENGINE_ACCOUNT = "engine";

/** Fraction of NAV risked between entry and stop on each new position. */
export const RISK_PER_TRADE = 0.005;
export const MAX_POSITION_WEIGHT = 0.08;
export const CASH_FLOOR = 0.02;
export const SECTOR_CAP = 0.25;
export const MAX_NEW_POSITIONS_PER_RUN = 5;
export const MIN_REWARD_RISK = 1;
export const HOLD_WEEKDAYS = 21;
const QUANTITY_DECIMALS = 4;
const UNKNOWN_SECTOR = "UNKNOWN";

export type EngineOrderReason = "engine_entry" | "stop" | "target" | "time" | "void";

export interface EngineEntryHit {
  hitId: string;
  ticker: string;
  /** Close of the hit's bar. Informational: entries are judged at the live price, not this. */
  entry: number;
  stop: number;
  target: number;
}

export interface EnginePaperPosition {
  ticker: string;
  quantity: number;
  avgCost: number;
  stopPrice: number | null;
  targetPrice: number | null;
  /** ISO date; the position is closed on or after it. */
  exitBy: string | null;
}

export interface EngineRunInput {
  nav: number;
  cash: number;
  positions: EnginePaperPosition[];
  /** Default fib hits from the latest engine bar date with no order yet. */
  hits: EngineEntryHit[];
  activeWatchlist: ReadonlySet<string>;
  prices: Readonly<Record<string, number>>;
  /** ISO date of this run. */
  today: string;
}

export interface EngineProposedOrder {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  refPrice: number;
  reason: EngineOrderReason;
  hitId: string | null;
  /** Buys only: carried onto the position so the loop can exit it later. */
  stopPrice: number | null;
  targetPrice: number | null;
  exitBy: string | null;
}

/** ISO date `count` weekdays after `from` (holidays are not netted out). */
export function addWeekdays(from: string, count: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  let left = count;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/** Same slippage schedule as the council accounts: 5 bps large-cap, 15 bps otherwise. */
const slippageBpsFor = (ticker: string): number => (isMegaOrLargeCap(ticker) ? 5 : 15);

/** What a market order at `refPrice` actually fills at: buys pay up, sells give up. */
const slippedPrice = (ticker: string, side: "buy" | "sell", refPrice: number): number =>
  refPrice * (1 + ((side === "buy" ? 1 : -1) * slippageBpsFor(ticker)) / 10_000);

const roundDown = (n: number): number => {
  const f = 10 ** QUANTITY_DECIMALS;
  return Math.floor(n * f) / f;
};

function exitReason(
  p: EnginePaperPosition,
  price: number,
  today: string,
  onWatchlist: boolean,
): EngineOrderReason | null {
  // Stop is checked before target so a gap through both reads as the loss.
  if (p.stopPrice !== null && price <= p.stopPrice) return "stop";
  if (p.targetPrice !== null && price >= p.targetPrice) return "target";
  if (p.exitBy !== null && today >= p.exitBy) return "time";
  if (!onWatchlist) return "void";
  return null;
}

/** Sells first (they free cash and sector room), then entries in reward/risk order. */
export function planEngineRun(input: EngineRunInput): EngineProposedOrder[] {
  const { nav, prices, today } = input;
  if (!(nav > 0)) return [];

  const orders: EngineProposedOrder[] = [];
  const held = new Map(input.positions.map((p) => [p.ticker, p]));
  let cash = input.cash;

  for (const p of input.positions) {
    const price = prices[p.ticker];
    if (!(price > 0)) continue;
    const reason = exitReason(p, price, today, input.activeWatchlist.has(p.ticker));
    if (!reason) continue;
    orders.push({
      ticker: p.ticker, side: "sell", quantity: p.quantity, refPrice: price, reason,
      hitId: null, stopPrice: null, targetPrice: null, exitBy: null,
    });
    cash += p.quantity * slippedPrice(p.ticker, "sell", price);
    held.delete(p.ticker);
  }

  const sectorWeight = new Map<string, number>();
  for (const p of held.values()) {
    const sector = sectorFor(p.ticker) ?? UNKNOWN_SECTOR;
    const price = prices[p.ticker] ?? p.avgCost;
    sectorWeight.set(sector, (sectorWeight.get(sector) ?? 0) + (p.quantity * price) / nav);
  }

  // Entries are judged at the price the buy will actually fill at, not at the
  // hit bar's close: the stop and target are fixed levels, so a price that has
  // drifted up eats reward and widens risk.
  const ranked = input.hits
    .flatMap((h) => {
      const price = prices[h.ticker];
      if (!(price > 0)) return [];
      const buyPrice = slippedPrice(h.ticker, "buy", price);
      if (!(buyPrice > h.stop && h.target > buyPrice)) return [];
      const rewardRisk = (h.target - buyPrice) / (buyPrice - h.stop);
      return rewardRisk >= MIN_REWARD_RISK ? [{ h, price, buyPrice, rewardRisk }] : [];
    })
    .sort((a, b) => b.rewardRisk - a.rewardRisk || a.h.ticker.localeCompare(b.h.ticker));

  let opened = 0;
  for (const { h, price, buyPrice } of ranked) {
    if (opened >= MAX_NEW_POSITIONS_PER_RUN) break;
    if (held.has(h.ticker) || !input.activeWatchlist.has(h.ticker)) continue;

    const riskQuantity = (RISK_PER_TRADE * nav) / (buyPrice - h.stop);
    const sector = sectorFor(h.ticker) ?? UNKNOWN_SECTOR;
    const sectorRoom = ((SECTOR_CAP - (sectorWeight.get(sector) ?? 0)) * nav) / buyPrice;
    const cashRoom = (cash - CASH_FLOOR * nav) / buyPrice;
    const quantity = roundDown(Math.min(riskQuantity, (MAX_POSITION_WEIGHT * nav) / buyPrice, sectorRoom, cashRoom));
    if (!(quantity > 0)) continue;

    orders.push({
      ticker: h.ticker, side: "buy", quantity, refPrice: price, reason: "engine_entry",
      hitId: h.hitId, stopPrice: h.stop, targetPrice: h.target, exitBy: addWeekdays(today, HOLD_WEEKDAYS),
    });
    cash -= quantity * buyPrice;
    sectorWeight.set(sector, (sectorWeight.get(sector) ?? 0) + (quantity * buyPrice) / nav);
    held.set(h.ticker, { ticker: h.ticker, quantity, avgCost: buyPrice, stopPrice: h.stop, targetPrice: h.target, exitBy: null });
    opened += 1;
  }
  return orders;
}

export interface EngineFill extends EngineProposedOrder {
  fillPrice: number;
  slippageBps: number;
  notional: number;
  realizedPnl: number | null;
}

/** A sell needs a cost basis to state P&L; a missing one is a caller bug, not a zero. */
export function fillEngineOrders(
  orders: readonly EngineProposedOrder[],
  avgCostByTicker: ReadonlyMap<string, number>,
): EngineFill[] {
  return orders.map((o) => {
    const fillPrice = slippedPrice(o.ticker, o.side, o.refPrice);
    let realizedPnl: number | null = null;
    if (o.side === "sell") {
      const avgCost = avgCostByTicker.get(o.ticker);
      if (avgCost === undefined) throw new Error(`Missing average cost for ${o.ticker}`);
      realizedPnl = o.quantity * (fillPrice - avgCost);
    }
    return { ...o, fillPrice, slippageBps: slippageBpsFor(o.ticker), notional: o.quantity * fillPrice, realizedPnl };
  });
}
