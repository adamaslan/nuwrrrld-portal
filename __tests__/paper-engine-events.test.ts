import { describe, expect, it } from "vitest";

import {
  addWeekdays,
  fillEngineOrders,
  planEngineRun,
  type EngineEntryHit,
  type EnginePaperPosition,
  type EngineRunInput,
} from "@/lib/shared/paper-engine-events";

const NAV = 100_000;
const hit = (ticker: string, entry = 100, stop = 95, target = 115): EngineEntryHit => ({ hitId: `hit-${ticker}`, ticker, entry, stop, target });
const base = (over: Partial<EngineRunInput> = {}): EngineRunInput => ({
  nav: NAV, cash: NAV, positions: [], hits: [], activeWatchlist: new Set(["AAPL", "MSFT", "ZZZ1", "ZZZ2"]),
  prices: { AAPL: 100, MSFT: 100, ZZZ1: 100, ZZZ2: 100 }, today: "2026-09-25", ...over,
});
const held = (over: Partial<EnginePaperPosition> = {}): EnginePaperPosition => ({
  ticker: "AAPL", quantity: 100, avgCost: 100, stopPrice: 95, targetPrice: 115, exitBy: "2026-10-23", ...over,
});

describe("addWeekdays", () => {
  it("skips weekends", () => {
    expect(addWeekdays("2026-09-25", 1)).toBe("2026-09-28"); // Fri -> Mon
    expect(addWeekdays("2026-09-25", 21)).toBe("2026-10-26");
  });
});

describe("planEngineRun entries", () => {
  it("sizes so a stop-out loses 0.5% of NAV", () => {
    const [order] = planEngineRun(base({ hits: [hit("AAPL", 100, 90, 115)] }));
    expect(order.side).toBe("buy");
    expect(order.quantity * (100 - 90)).toBeCloseTo(0.005 * NAV, 1);
    expect(order.stopPrice).toBe(90);
    expect(order.targetPrice).toBe(115);
    expect(order.exitBy).toBe("2026-10-26");
    expect(order.hitId).toBe("hit-AAPL");
  });

  it("lets the 8% weight cap bind when the risk-based size is larger", () => {
    const [order] = planEngineRun(base({ hits: [hit("AAPL")] }));
    expect(order.quantity * 100).toBeCloseTo(0.08 * NAV, 0);
  });

  it("caps a tight-stop position at 8% of NAV", () => {
    const [order] = planEngineRun(base({ hits: [hit("AAPL", 100, 99.5, 120)] }));
    expect(order.quantity * 100).toBeLessThanOrEqual(0.08 * NAV + 1e-6);
  });

  it("rejects reward/risk below 1 and malformed hits", () => {
    expect(planEngineRun(base({ hits: [hit("AAPL", 100, 95, 103), hit("MSFT", 100, 105, 120)] }))).toEqual([]);
  });

  it("opens at most 5 new positions per run, best reward/risk first", () => {
    const tickers = ["AAPL", "MSFT", "ZZZ1", "ZZZ2", "AA1", "AA2", "AA3"];
    const prices = Object.fromEntries(tickers.map((t) => [t, 100]));
    const hits = tickers.map((t, i) => hit(t, 100, 95, 110 + i * 5));
    const orders = planEngineRun(base({ hits, prices, activeWatchlist: new Set(tickers) }));
    expect(orders).toHaveLength(5);
    expect(orders[0].ticker).toBe("AA3");
  });

  it("never spends below the 2% cash floor", () => {
    const orders = planEngineRun(base({ cash: 0.02 * NAV + 500, hits: [hit("AAPL")] }));
    const spent = orders.reduce((s, o) => s + o.quantity * o.refPrice, 0);
    expect(spent).toBeLessThanOrEqual(500 + 1e-6);
  });

  it("skips held tickers and tickers off the watchlist", () => {
    const orders = planEngineRun(base({ positions: [held()], hits: [hit("AAPL"), hit("NOPE")], prices: { AAPL: 100, NOPE: 100 }, activeWatchlist: new Set(["AAPL"]) }));
    expect(orders).toEqual([]);
  });

  it("enforces the unknown-sector cap across new entries", () => {
    const tickers = ["ZZZ1", "ZZZ2", "ZZZ3", "ZZZ4", "ZZZ5"];
    const prices = Object.fromEntries(tickers.map((t) => [t, 100]));
    const hits = tickers.map((t) => hit(t, 100, 99, 130));
    const orders = planEngineRun(base({ hits, prices, activeWatchlist: new Set(tickers) }));
    const weight = orders.reduce((s, o) => s + o.quantity * o.refPrice, 0) / NAV;
    expect(weight).toBeLessThanOrEqual(0.25 + 1e-9);
  });
});

describe("planEngineRun exits", () => {
  const exit = (p: EnginePaperPosition, price: number, over: Partial<EngineRunInput> = {}) =>
    planEngineRun(base({ positions: [p], prices: { AAPL: price }, ...over }));

  it("sells on stop, target, time and watchlist removal", () => {
    expect(exit(held(), 94)[0].reason).toBe("stop");
    expect(exit(held(), 116)[0].reason).toBe("target");
    expect(exit(held(), 100, { today: "2026-10-23" })[0].reason).toBe("time");
    expect(exit(held(), 100, { activeWatchlist: new Set() })[0].reason).toBe("void");
  });

  it("holds when nothing triggers", () => {
    expect(exit(held(), 105)).toEqual([]);
  });

  it("reads a gap through both barriers as the stop", () => {
    expect(exit(held({ stopPrice: 95, targetPrice: 96 }), 94)[0].reason).toBe("stop");
  });

  it("sells the whole position and skips a ticker with no price", () => {
    expect(exit(held({ quantity: 42 }), 94)[0].quantity).toBe(42);
    expect(planEngineRun(base({ positions: [held()], prices: {} }))).toEqual([]);
  });

  it("uses sale proceeds to fund entries in the same run", () => {
    const orders = planEngineRun(base({ cash: 0, positions: [held({ quantity: 200 })], prices: { AAPL: 94, MSFT: 100 }, hits: [hit("MSFT")], nav: NAV }));
    expect(orders.map((o) => o.side)).toEqual(["sell", "buy"]);
  });
});

describe("fillEngineOrders", () => {
  it("applies slippage against the trader and books realized P&L", () => {
    const [sell] = fillEngineOrders(
      [{ ticker: "AAPL", side: "sell", quantity: 10, refPrice: 110, reason: "target", hitId: null, stopPrice: null, targetPrice: null, exitBy: null }],
      new Map([["AAPL", 100]]),
    );
    expect(sell.fillPrice).toBeLessThan(110);
    expect(sell.realizedPnl).toBeCloseTo(10 * (sell.fillPrice - 100));
  });
});
