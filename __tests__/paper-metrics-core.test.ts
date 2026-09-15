import { describe, expect, it } from "vitest";
import {
  computeAccountMetrics,
  computeAnnualizedVol,
  computeAvgHoldingPeriodDays,
  computeCagr,
  computeDrawdowns,
  computeHitRateStats,
  computeSharpeRf0,
  type MetricsNavPoint,
  type MetricsOrder,
} from "@/lib/shared/paper-metrics-core";

function nav(points: [string, number][]): MetricsNavPoint[] {
  return points.map(([tradeDate, navValue]) => ({ tradeDate, nav: navValue }));
}

describe("computeCagr", () => {
  it("returns null under 2 points", () => {
    expect(computeCagr([])).toBeNull();
    expect(computeCagr(nav([["2026-01-01", 10_000]]))).toBeNull();
  });

  it("computes (end/start)^(1/years) - 1 over the actual calendar span", () => {
    // Exactly 1 year, 10% growth.
    const series = nav([
      ["2025-01-01", 10_000],
      ["2026-01-01", 11_000],
    ]);
    expect(computeCagr(series)!).toBeCloseTo(0.1, 3);
  });

  it("null on non-positive nav", () => {
    expect(computeCagr(nav([["2025-01-01", 0], ["2026-01-01", 100]]))).toBeNull();
  });
});

describe("computeAnnualizedVol / computeSharpeRf0", () => {
  it("null with fewer than 2 daily returns", () => {
    expect(computeAnnualizedVol(nav([["2026-01-01", 100]]))).toBeNull();
    expect(computeSharpeRf0(nav([["2026-01-01", 100]]))).toBeNull();
  });

  it("zero vol on a perfectly flat series yields null Sharpe, not Infinity", () => {
    const series = nav([
      ["2026-01-01", 100],
      ["2026-01-02", 100],
      ["2026-01-03", 100],
    ]);
    expect(computeAnnualizedVol(series)).toBe(0);
    expect(computeSharpeRf0(series)).toBeNull();
  });

  it("positive drift with nonzero vol gives a positive Sharpe", () => {
    const series = nav([
      ["2026-01-01", 100],
      ["2026-01-02", 102],
      ["2026-01-03", 101],
      ["2026-01-04", 105],
    ]);
    expect(computeSharpeRf0(series)!).toBeGreaterThan(0);
    expect(computeAnnualizedVol(series)!).toBeGreaterThan(0);
  });
});

describe("computeDrawdowns", () => {
  it("null on an empty series", () => {
    expect(computeDrawdowns([])).toEqual({ maxDrawdown: null, currentDrawdown: null });
  });

  it("tracks the worst peak-to-trough dip and the current dip from the running peak", () => {
    const series = nav([
      ["2026-01-01", 100],
      ["2026-01-02", 120], // new peak
      ["2026-01-03", 90], // -25% from peak — the max drawdown
      ["2026-01-04", 108], // recovers to -10% from peak
    ]);
    const { maxDrawdown, currentDrawdown } = computeDrawdowns(series);
    expect(maxDrawdown!).toBeCloseTo(-0.25, 5);
    expect(currentDrawdown!).toBeCloseTo(-0.1, 5);
  });
});

describe("computeHitRateStats", () => {
  const orders: MetricsOrder[] = [
    { ticker: "A", side: "buy", createdAt: "2026-01-01T00:00:00Z", realizedPnl: null },
    { ticker: "A", side: "sell", createdAt: "2026-01-05T00:00:00Z", realizedPnl: 50 },
    { ticker: "B", side: "buy", createdAt: "2026-01-02T00:00:00Z", realizedPnl: null },
    { ticker: "B", side: "sell", createdAt: "2026-01-03T00:00:00Z", realizedPnl: -20 },
    { ticker: "C", side: "buy", createdAt: "2026-01-02T00:00:00Z", realizedPnl: null },
  ];

  it("counts only sells as closed positions and splits win/loss correctly", () => {
    const stats = computeHitRateStats(orders);
    expect(stats.closedPositions).toBe(2);
    expect(stats.hitRate).toBeCloseTo(0.5, 5);
    expect(stats.avgWin).toBe(50);
    expect(stats.avgLoss).toBe(-20);
  });

  it("null stats with zero closed positions", () => {
    const stats = computeHitRateStats([orders[0], orders[2]]);
    expect(stats).toEqual({ closedPositions: 0, hitRate: null, avgWin: null, avgLoss: null });
  });
});

describe("computeAvgHoldingPeriodDays", () => {
  it("measures from the first buy since flat to the closing sell", () => {
    const orders: MetricsOrder[] = [
      { ticker: "A", side: "buy", createdAt: "2026-01-01T00:00:00Z", realizedPnl: null },
      { ticker: "A", side: "buy", createdAt: "2026-01-02T00:00:00Z", realizedPnl: null }, // top-up, doesn't reset the clock
      { ticker: "A", side: "sell", createdAt: "2026-01-11T00:00:00Z", realizedPnl: 10 }, // 10 days from the first buy
    ];
    expect(computeAvgHoldingPeriodDays(orders)).toBeCloseTo(10, 5);
  });

  it("re-opens the clock after a full exit", () => {
    const orders: MetricsOrder[] = [
      { ticker: "A", side: "buy", createdAt: "2026-01-01T00:00:00Z", realizedPnl: null },
      { ticker: "A", side: "sell", createdAt: "2026-01-03T00:00:00Z", realizedPnl: 5 }, // 2 days
      { ticker: "A", side: "buy", createdAt: "2026-01-10T00:00:00Z", realizedPnl: null },
      { ticker: "A", side: "sell", createdAt: "2026-01-14T00:00:00Z", realizedPnl: -5 }, // 4 days
    ];
    expect(computeAvgHoldingPeriodDays(orders)).toBeCloseTo(3, 5); // mean(2, 4)
  });

  it("null with no closed position", () => {
    expect(computeAvgHoldingPeriodDays([])).toBeNull();
  });
});

describe("computeAccountMetrics", () => {
  it("computes active return vs spy/equal only when both sides are known", () => {
    const metrics = computeAccountMetrics([], [], [], 0.12, 0.001, 0.05, null);
    expect(metrics.activeReturnVsSpy).toBeCloseTo(0.07, 5);
    expect(metrics.activeReturnVsEqual).toBeNull();
  });

  it("rolling turnover is the mean of the recent-run window", () => {
    const metrics = computeAccountMetrics([], [0.1, 0.2, 0.3], [], null, null, null, null);
    expect(metrics.rollingTurnover!).toBeCloseTo(0.2, 5);
  });
});
