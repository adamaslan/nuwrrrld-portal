import { describe, expect, it } from "vitest";
import { PAPER_POLICY } from "@/lib/shared/paper-policy";
import {
  fillOrders,
  planRun,
  type EngineCandidate,
  type EnginePosition,
  type RunPlanInput,
} from "@/lib/shared/paper-engine-core";

const QUANT = PAPER_POLICY.quant; // buyThreshold 75, sellThreshold 50, maxWeight 0.04, cashFloor 0

function baseInput(overrides: Partial<RunPlanInput> = {}): RunPlanInput {
  return {
    policy: QUANT,
    nav: 10_000,
    cash: 10_000,
    positions: [],
    candidates: [],
    activeWatchlist: new Set(["AAPL", "MSFT", "JNJ"]),
    prices: { AAPL: 200, MSFT: 400, JNJ: 150 },
    ...overrides,
  };
}

describe("planRun — buys", () => {
  it("opens no position for a candidate under the buy threshold", () => {
    const candidates: EngineCandidate[] = [{ ticker: "AAPL", score: 74 }];
    const plan = planRun(baseInput({ candidates }));
    expect(plan.orders).toHaveLength(0);
  });

  it("buys a candidate at/above the buy threshold, sized to maxPositionWeight", () => {
    const candidates: EngineCandidate[] = [{ ticker: "AAPL", score: 90 }];
    const plan = planRun(baseInput({ candidates }));
    expect(plan.orders).toHaveLength(1);
    const o = plan.orders[0];
    expect(o.side).toBe("buy");
    expect(o.ticker).toBe("AAPL");
    // maxPositionWeight 0.04 * nav 10_000 = 400 notional @ $200 = 2 shares
    expect(o.quantity).toBeCloseTo(2, 6);
    expect(o.reason).toBe("score_entry");
  });

  it("ranks buys by score descending, ticker ascending as the tie-break", () => {
    const candidates: EngineCandidate[] = [
      { ticker: "MSFT", score: 80 },
      { ticker: "AAPL", score: 90 },
    ];
    const plan = planRun(baseInput({ candidates, cash: 1000, nav: 1000 }));
    // Both want in, cash-limited — AAPL (higher score) should be filled first.
    expect(plan.orders[0].ticker).toBe("AAPL");
  });

  it("never buys a ticker outside the active watchlist even if it scores high", () => {
    const candidates: EngineCandidate[] = [{ ticker: "TSLA", score: 99 }];
    const plan = planRun(
      baseInput({ candidates, activeWatchlist: new Set(["AAPL"]), prices: { AAPL: 200, TSLA: 300 } }),
    );
    expect(plan.orders).toHaveLength(0);
  });

  it("never buys a ticker with no reference price", () => {
    const candidates: EngineCandidate[] = [{ ticker: "JNJ", score: 90 }];
    const plan = planRun(
      baseInput({ candidates, activeWatchlist: new Set(["JNJ"]), prices: {} }),
    );
    expect(plan.orders).toHaveLength(0);
  });

  it("clips a buy to the turnover cap", () => {
    // quant's maxTurnoverPerRun is 0.12 -> $1,200 of a $10,000 NAV.
    const candidates: EngineCandidate[] = [
      { ticker: "AAPL", score: 90 },
      { ticker: "MSFT", score: 89 },
    ];
    const richPolicy = { ...QUANT, maxPositionWeight: 0.5 }; // remove position cap as the binding constraint
    const plan = planRun(baseInput({ candidates, policy: richPolicy }));
    const totalNotional = plan.orders.reduce((n, o) => n + o.quantity * o.refPrice, 0);
    expect(totalNotional).toBeLessThanOrEqual(richPolicy.maxTurnoverPerRun * 10_000 + 1e-6);
  });

  it("clips buys once the cash floor is reached", () => {
    const cashFloorPolicy = { ...QUANT, cashFloor: 0.9, maxTurnoverPerRun: 1, maxPositionWeight: 1 };
    const candidates: EngineCandidate[] = [{ ticker: "AAPL", score: 90 }];
    const plan = planRun(baseInput({ candidates, policy: cashFloorPolicy, cash: 10_000, nav: 10_000 }));
    // Only 10% of NAV (1,000) may leave cash; 200/share -> at most 5 shares.
    expect(plan.orders[0].quantity).toBeLessThanOrEqual(5 + 1e-9);
  });

  it("clips buys once the sector cap is reached", () => {
    // AAPL and MSFT are both Technology (lib/shared/paper-sectors.ts).
    const tightSectorPolicy = { ...QUANT, sectorCapPct: 0.05, maxPositionWeight: 1, maxTurnoverPerRun: 1 };
    const positions: EnginePosition[] = [
      { ticker: "AAPL", quantity: 2, avgCost: 200, runsHeld: 10, highWater: 200 }, // 400/10000 = 4%
    ];
    const candidates: EngineCandidate[] = [{ ticker: "MSFT", score: 90 }];
    const plan = planRun(
      baseInput({ candidates, positions, policy: tightSectorPolicy, cash: 9_600, nav: 10_000 }),
    );
    // Only 1% of sector room (100 notional) left -> 100/400 = 0.25 shares of MSFT.
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].quantity).toBeCloseTo(0.25, 6);
  });
});

describe("planRun — sells", () => {
  it("exits a position whose score has fallen below the sell threshold, once min holding is satisfied", () => {
    const positions: EnginePosition[] = [
      { ticker: "AAPL", quantity: 2, avgCost: 200, runsHeld: 5, highWater: 220 },
    ];
    const candidates: EngineCandidate[] = [{ ticker: "AAPL", score: 20 }]; // < 50 sellThreshold
    const plan = planRun(baseInput({ positions, candidates, cash: 9_600, nav: 10_000 }));
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0]).toMatchObject({ ticker: "AAPL", side: "sell", reason: "score_exit" });
  });

  it("does not exit on signal alone before the minimum holding period", () => {
    const holdPolicy = { ...QUANT, minHoldingPeriodRuns: 4 };
    const positions: EnginePosition[] = [
      { ticker: "AAPL", quantity: 2, avgCost: 200, runsHeld: 1, highWater: 200 },
    ];
    const candidates: EngineCandidate[] = [{ ticker: "AAPL", score: 20 }];
    const plan = planRun(baseInput({ positions, candidates, policy: holdPolicy, cash: 9_600, nav: 10_000 }));
    expect(plan.orders).toHaveLength(0);
  });

  it("a fixed stop overrides the minimum holding period", () => {
    const holdPolicy = { ...QUANT, minHoldingPeriodRuns: 20, stopRule: { kind: "fixed" as const, pct: 0.1 } };
    const positions: EnginePosition[] = [
      { ticker: "AAPL", quantity: 2, avgCost: 200, runsHeld: 1, highWater: 200 },
    ];
    // Price at 170 is an 15% drawdown from a 200 entry — past the 10% stop.
    const plan = planRun(
      baseInput({ positions, policy: holdPolicy, prices: { AAPL: 170 }, cash: 9_600, nav: 10_000 }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].reason).toBe("stop");
  });

  it("a trailing stop measures from the high-water mark, not the entry price", () => {
    const trailingPolicy = { ...QUANT, minHoldingPeriodRuns: 20, stopRule: { kind: "trailing" as const, pct: 0.05 } };
    const positions: EnginePosition[] = [
      // Entry 100, ran up to a high water of 300, now back to 280: only a ~6.7%
      // drawdown from the high, past a 5% trailing stop, despite being hugely
      // profitable from entry.
      { ticker: "AAPL", quantity: 2, avgCost: 100, runsHeld: 1, highWater: 300 },
    ];
    const plan = planRun(
      baseInput({ positions, policy: trailingPolicy, prices: { AAPL: 280 }, cash: 9_600, nav: 10_000 }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].reason).toBe("stop");
  });

  it("force-exits a position whose ticker fell off the active watchlist, ignoring min holding period", () => {
    const holdPolicy = { ...QUANT, minHoldingPeriodRuns: 999 };
    const positions: EnginePosition[] = [
      { ticker: "AAPL", quantity: 2, avgCost: 200, runsHeld: 1, highWater: 200 },
    ];
    const plan = planRun(
      baseInput({ positions, policy: holdPolicy, activeWatchlist: new Set(), cash: 9_600, nav: 10_000 }),
    );
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].reason).toBe("void");
  });

  it("holds a position with no candidate score this run (no signal either way)", () => {
    const positions: EnginePosition[] = [
      { ticker: "AAPL", quantity: 2, avgCost: 200, runsHeld: 5, highWater: 200 },
    ];
    const plan = planRun(baseInput({ positions, candidates: [], cash: 9_600, nav: 10_000 }));
    expect(plan.orders).toHaveLength(0);
  });
});

describe("planRun — degenerate input", () => {
  it("returns no orders and zero turnover when NAV is zero", () => {
    const plan = planRun(baseInput({ nav: 0, cash: 0 }));
    expect(plan).toEqual({ orders: [], turnoverUsed: 0 });
  });
});

describe("fillOrders", () => {
  it("applies 5bps slippage for a Core 50 / ETF ticker, against the account both ways", () => {
    const filled = fillOrders(
      [
        { ticker: "AAPL", side: "buy", quantity: 1, refPrice: 100, reason: "score_entry" },
        { ticker: "AAPL", side: "sell", quantity: 1, refPrice: 100, reason: "score_exit" },
      ],
      new Map([["AAPL", 90]]),
    );
    expect(filled[0].slippageBps).toBe(5);
    expect(filled[0].fillPrice).toBeCloseTo(100.05, 6); // buy pays up
    expect(filled[1].fillPrice).toBeCloseTo(99.95, 6); // sell receives less
  });

  it("applies 15bps slippage for a non-Core-50, non-ETF ticker", () => {
    const filled = fillOrders(
      [{ ticker: "PLTR", side: "buy", quantity: 1, refPrice: 100, reason: "score_entry" }],
      new Map(),
    );
    expect(filled[0].slippageBps).toBe(15);
    expect(filled[0].fillPrice).toBeCloseTo(100.15, 6);
  });

  it("computes realized P&L for a sell against the position's avg cost, and leaves it null for a buy", () => {
    const filled = fillOrders(
      [
        { ticker: "AAPL", side: "sell", quantity: 2, refPrice: 150, reason: "score_exit" },
        { ticker: "MSFT", side: "buy", quantity: 1, refPrice: 400, reason: "score_entry" },
      ],
      new Map([["AAPL", 100]]),
    );
    // fillPrice = 150 * (1 - 5bps) = 149.925; pnl = 2 * (149.925 - 100)
    expect(filled[0].realizedPnl).toBeCloseTo(2 * (149.925 - 100), 3);
    expect(filled[1].realizedPnl).toBeNull();
  });
});
