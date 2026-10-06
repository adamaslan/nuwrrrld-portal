import { describe, expect, it, vi } from "vitest";

// buildPaperAccountStatuses is pure; the module imports the Neon client at
// load time, so stub it to keep the import graph free of DATABASE_URL.
vi.mock("@/lib/db", () => ({
  default: () => Promise.reject(new Error("DB query attempted in a pure-function test")),
}));

import { buildPaperAccountStatuses } from "@/lib/paper-status-db";

describe("buildPaperAccountStatuses", () => {
  it("returns every paper account, in policy order, even with no rows", () => {
    const out = buildPaperAccountStatuses({ accounts: [], runs: [], nav: [], positions: [] });
    expect(out.map((s) => s.account)).toEqual([
      "t1", "t2", "risk", "macro", "quant", "chair", "equal", "spy",
    ]);
    expect(out.every((s) => s.slots.every((slot) => slot === null))).toBe(true);
    expect(out.every((s) => s.nav === null && s.openPositions === 0)).toBe(true);
  });

  it("falls back to the account key when no paper_accounts row exists", () => {
    const [t1] = buildPaperAccountStatuses({ accounts: [], runs: [], nav: [], positions: [] });
    expect(t1.label).toBe("t1");
    expect(t1.active).toBe(false);
  });

  it("maps a seeded account, its latest NAV, and its open positions", () => {
    const [t1] = buildPaperAccountStatuses({
      accounts: [
        { account: "t1", seat: "T1", label: "Tech 1", active: true, cash: "4200.5", starting_cash: "10000" },
      ],
      runs: [],
      nav: [{ account: "t1", trade_date: new Date("2026-10-02T00:00:00Z"), nav: "10850.25", total_return: "0.0850" }],
      positions: [{ account: "t1", open_positions: "7" }],
    });
    expect(t1).toMatchObject({
      label: "Tech 1",
      seat: "T1",
      active: true,
      cash: 4200.5,
      startingCash: 10000,
      nav: 10850.25,
      totalReturn: 0.085,
      navDate: "2026-10-02",
      openPositions: 7,
    });
  });

  it("places each slot's run in slot order and leaves unrun slots null", () => {
    const [t1] = buildPaperAccountStatuses({
      accounts: [],
      runs: [
        {
          account: "t1",
          slot: "settle",
          trade_date: "2026-10-02",
          status: "degraded",
          skip_reason: "quote_gap",
          orders_n: 0,
          model_calls: 3,
          started_at: "2026-10-02T21:30:00.000Z",
        },
      ],
      nav: [],
      positions: [],
    });
    expect(t1.slots.map((s) => s?.slot ?? null)).toEqual([null, null, null, "settle"]);
    expect(t1.slots[3]).toMatchObject({
      status: "degraded",
      skipReason: "quote_gap",
      ordersN: 0,
      modelCalls: 3,
      tradeDate: "2026-10-02",
    });
  });

  it("does not let one account's run leak into another's slots", () => {
    const out = buildPaperAccountStatuses({
      accounts: [],
      runs: [{ account: "spy", slot: "midday", trade_date: "2026-10-02", status: "ok", model_calls: 0, started_at: "x" }],
      nav: [],
      positions: [],
    });
    expect(out.find((s) => s.account === "t1")?.slots.every((s) => s === null)).toBe(true);
    expect(out.find((s) => s.account === "spy")?.slots[1]?.status).toBe("ok");
  });
});
