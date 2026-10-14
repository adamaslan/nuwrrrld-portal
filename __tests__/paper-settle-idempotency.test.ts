import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  sql: Object.assign(vi.fn(), { transaction: vi.fn() }),
  getAccount: vi.fn(),
  getPositions: vi.fn(),
  listActiveWatchlist: vi.fn(),
  getScreenCandidates: vi.fn(),
  getSeatOrdersForSlot: vi.fn(),
  getRecentlyStoppedTickers: vi.fn(),
  updateRunDetail: vi.fn(),
  countOrders: vi.fn(),
  latestCardBarDate: vi.fn(),
  getLivePricesWithAge: vi.fn(),
  arbitrateOne: vi.fn(),
  mirrorPaperAccount: vi.fn(),
  mirrorWatchlistIfVersionChanged: vi.fn(),
  reconcileAccount: vi.fn(),
  computeMetricsForAccount: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ default: mocks.sql }));
vi.mock("@/lib/paper-db", () => mocks);
vi.mock("@/lib/ticker-cards-db", () => ({ latestCardBarDate: mocks.latestCardBarDate }));
vi.mock("@/lib/live-price-db", () => ({ getLivePricesWithAge: mocks.getLivePricesWithAge }));
vi.mock("@/lib/paper-arbitration", () => ({ arbitrateOne: mocks.arbitrateOne }));
vi.mock("@/lib/paper-firestore-mirror", () => ({
  mirrorPaperAccount: mocks.mirrorPaperAccount,
  mirrorWatchlistIfVersionChanged: mocks.mirrorWatchlistIfVersionChanged,
}));
vi.mock("@/lib/paper-reconcile", () => ({ reconcileAccount: mocks.reconcileAccount }));
vi.mock("@/lib/paper-metrics", () => ({ computeMetricsForAccount: mocks.computeMetricsForAccount }));

import { runAccountSlot } from "@/lib/paper-engine";
import type { RunRow } from "@/lib/paper-db";

describe("settle run idempotency", () => {
  it("returns the completed run on sequential retries without marking or writing again", async () => {
    vi.clearAllMocks();
    const existing: RunRow = {
      id: "completed-settle-run",
      account: "quant",
      tradeDate: "2026-10-12",
      slot: "settle",
      status: "ok",
      skipReason: null,
      candidatesN: 0,
      ordersN: 0,
      modelCalls: 0,
      policyVersion: "test-policy",
      detail: {},
      startedAt: "2026-10-12T20:15:00.000Z",
      finishedAt: "2026-10-12T20:15:01.000Z",
    };
    mocks.getRun.mockResolvedValue(existing);

    const firstRetry = await runAccountSlot("quant", existing.tradeDate, "settle");
    const secondRetry = await runAccountSlot("quant", existing.tradeDate, "settle");

    expect(firstRetry).toEqual({
      account: "quant",
      tradeDate: existing.tradeDate,
      slot: "settle",
      status: existing.status,
      skipReason: existing.skipReason,
      candidatesN: existing.candidatesN,
      ordersN: existing.ordersN,
      modelCalls: existing.modelCalls,
      alreadyRan: true,
    });
    expect(secondRetry).toEqual(firstRetry);
    expect(mocks.getRun).toHaveBeenCalledTimes(2);
    expect(mocks.getRun).toHaveBeenNthCalledWith(1, "quant", existing.tradeDate, "settle");
    expect(mocks.getRun).toHaveBeenNthCalledWith(2, "quant", existing.tradeDate, "settle");

    for (const [name, mock] of Object.entries(mocks)) {
      if (name !== "getRun") expect(mock, name).not.toHaveBeenCalled();
    }
    expect(mocks.sql.transaction).not.toHaveBeenCalled();
  });
});
