import { describe, it, expect } from "vitest";
import { buildArenaView, rankValues, reasonLabel, type ArenaAccountInput } from "@/lib/shared/paper-arena-view";
import type { NavPoint, OrderRow } from "@/lib/paper-db";
import type { PaperAccount } from "@/lib/shared/paper-policy";

function nav(account: PaperAccount, date: string, value: number, total: number): NavPoint {
  return { account, tradeDate: date, slot: "settle", cash: 0, positionsMv: value, nav: value, dayReturn: 0.01, totalReturn: total, positionsN: 3, turnover: 0 };
}
function order(account: PaperAccount, id: string, over: Partial<OrderRow> = {}): OrderRow {
  return {
    id, runId: "r", account, ticker: "NVDA", side: "buy", quantity: 2, refPrice: 100, fillPrice: 100, slippageBps: 0,
    notional: 200, realizedPnl: null, reason: "score_entry", decidedBy: "rule", model: null, cardScore: 70,
    createdAt: "2026-10-01T14:00:00.000Z", ...over,
  };
}
function input(account: PaperAccount, ret: number, sharpe: number, dd: number, hit: number, vsSpy: number, extra: Partial<ArenaAccountInput> = {}): ArenaAccountInput {
  return {
    account, seat: null, label: account, cash: 1000,
    metrics: {
      totalReturn: ret, dayReturn: 0.01, cagr: null, annualizedVol: 0.2, sharpeRf0: sharpe, maxDrawdown: dd, currentDrawdown: 0,
      closedPositions: 4, hitRate: hit, avgWin: 50, avgLoss: -25, rollingTurnover: 0.1, avgHoldingPeriodDays: 5,
      activeReturnVsSpy: vsSpy, activeReturnVsEqual: 0,
    },
    nav: [nav(account, "2026-10-01", 10000, 0), nav(account, "2026-10-02", 10000 * (1 + ret), ret)],
    latestNav: nav(account, "2026-10-02", 10000 * (1 + ret), ret),
    orders: [], positions: [], ...extra,
  };
}

describe("rankValues", () => {
  it("ranks higher-is-better, ties share the best rank, nulls unranked", () => {
    expect(rankValues([3, 1, 3, null], "higher")).toEqual([1, 3, 1, null]);
  });
  it("ranks lower-is-better", () => {
    expect(rankValues([3, 1, 2], "lower")).toEqual([3, 1, 2]);
  });
});

describe("buildArenaView", () => {
  it("ranks contestants on the mean of five metric ranks and leaves baselines unranked", () => {
    const view = buildArenaView([
      input("t1", 0.10, 1.5, -0.05, 0.7, 0.04),
      input("t2", 0.02, 0.4, -0.12, 0.4, -0.04),
      input("spy", 0.06, 1, -0.06, 0.5, 0),
    ]);
    const t1 = view.rows.find((r) => r.account === "t1")!;
    const t2 = view.rows.find((r) => r.account === "t2")!;
    const spy = view.rows.find((r) => r.account === "spy")!;
    expect(t1.judgeRank).toBe(1);
    expect(t2.judgeRank).toBe(2);
    expect(t1.judgeScore).toBe(1);
    expect(spy.judgeRank).toBeNull();
    expect(spy.isBaseline).toBe(true);
    expect(t1.bestIn).toHaveLength(5);
    expect(t2.bestIn).toEqual([]);
    expect(view.rows[view.rows.length - 1].account).toBe("spy"); // baselines last
  });

  it("does not crown a 'best in' badge with a single contestant", () => {
    const view = buildArenaView([input("t1", 0.1, 1, -0.05, 0.7, 0.04)]);
    expect(view.rows[0].bestIn).toEqual([]);
  });

  it("handles an account with no metrics or history", () => {
    const view = buildArenaView([{ account: "quant", seat: "QUANT", label: "Quant", cash: 10000, metrics: null, nav: [], latestNav: null, orders: [], positions: [] }]);
    const row = view.rows[0];
    expect(row.nav).toBe(10000);
    expect(row.totalReturnPct).toBeNull();
    expect(row.judgeScore).toBeNull();
    expect(row.payoffRatio).toBeNull();
    expect(view.curves.quant).toEqual([]);
  });

  it("rebases curves to 100 and computes payoff ratio and percent scaling", () => {
    const view = buildArenaView([input("t1", 0.1, 1, -0.05, 0.7, 0.04)]);
    expect(view.curves.t1![0].indexed).toBe(100);
    expect(view.curves.t1![1].indexed).toBeCloseTo(110);
    const row = view.rows[0];
    expect(row.payoffRatio).toBe(2);
    expect(row.totalReturnPct).toBeCloseTo(10);
    expect(row.maxDrawdownPct).toBeCloseTo(-5);
  });

  it("merges trades newest-first, glosses reasons, attaches thesis, and totals P&L per reason", () => {
    const view = buildArenaView([
      input("t1", 0.1, 1, -0.05, 0.7, 0.04, {
        orders: [
          order("t1", "a", { createdAt: "2026-10-01T14:00:00.000Z" }),
          order("t1", "b", { side: "sell", reason: "stop", realizedPnl: -30, createdAt: "2026-10-03T14:00:00.000Z" }),
          order("t1", "c", { side: "sell", reason: "stop", realizedPnl: -10, createdAt: "2026-10-02T14:00:00.000Z" }),
        ],
        positions: [{ account: "t1", ticker: "NVDA", thesis: "AI capex runway" } as never],
      }),
      input("t2", 0.02, 0.4, -0.12, 0.4, -0.04, { orders: [order("t2", "d", { createdAt: "2026-10-04T14:00:00.000Z" })] }),
    ]);
    expect(view.trades.map((t) => t.id)).toEqual(["d", "b", "c", "a"]);
    expect(view.trades[1].reasonText).toBe(reasonLabel("stop"));
    expect(view.trades[3].thesis).toBe("AI capex runway");
    const stop = view.reasonBreakdown.t1!.find((s) => s.reason === "stop")!;
    expect(stop).toMatchObject({ count: 2, realizedPnl: -40 });
  });

  it("falls back to the raw reason string for unknown reasons", () => {
    expect(reasonLabel("mystery")).toBe("mystery");
  });
});
