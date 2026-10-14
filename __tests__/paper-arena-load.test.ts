import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadArena } from "@/lib/paper-arena";
import { computeMetricsForAccount, readStoredMetrics } from "@/lib/paper-metrics";
import { getNavSeries, getSettleNavSeries, getPositions, listAccounts, listOrders } from "@/lib/paper-db";
import { PAPER_ACCOUNTS } from "@/lib/shared/paper-policy";
import { buildArenaView } from "@/lib/shared/paper-arena-view";
import * as metricsCore from "@/lib/shared/paper-metrics-core";

const sql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ default: sql }));
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  tables = { paper_accounts: [], paper_nav: [], paper_orders: [], paper_positions: [], paper_runs: [] };
  for (const [index, account] of PAPER_ACCOUNTS.entries()) {
    tables.paper_accounts.push({ account, label: account, seat: null, cash: "5000", starting_cash: "10000", policy_version: "1", seeded_on: "2025-01-01", updated_at: "2026-10-01", active: true });
    for (let i = 0; i < 405; i++) {
      tables.paper_nav.push({ account, slot: "settle", trade_date: new Date(Date.UTC(2025, 0, i + 1)).toISOString(), nav: 10000 + i * (index + 1), cash: "5000", positions_mv: 5000 + i, positions_n: 1, turnover: i / 1000, total_return: i / 10000, day_return: 0.001 });
    }
    // Intraday marks must affect latest NAV/turnover, never the settle chart.
    tables.paper_nav.push({ ...tables.paper_nav.at(-1), slot: "preclose", nav: 12000, turnover: 0.9 });
    for (let i = 0; i < 120; i++) {
      tables.paper_orders.push({ account, id: `${account}-${i}`, run_id: "run", ticker: `T${Math.floor(i / 2)}`, side: i % 2 ? "sell" : "buy", quantity: "1", ref_price: "100", fill_price: "100", slippage_bps: 0, notional: "100", realized_pnl: i % 2 ? i - 50 : null, reason: "fixture", decided_by: "rule", created_at: new Date(Date.UTC(2025, 0, i + 1)).toISOString() });
    }
    tables.paper_positions.push({ account, ticker: "XYZ", quantity: "2", avg_cost: "100", opened_at: "2025-01-01", last_trade_at: "2025-01-01", runs_held: "3", high_water: "120" });
  }
  sql.mockReset();
  sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    const table = query.match(/FROM (paper_\w+)/)?.[1];
    if (!table) throw new Error(query);
    let rows = [...tables[table]];
    const batch = values.find(Array.isArray) as string[] | undefined;
    const single = values.find((v) => typeof v === "string" && PAPER_ACCOUNTS.includes(v as never));
    if (batch) rows = rows.filter((r) => batch.includes(String(r.account)));
    else if (single) rows = rows.filter((r) => r.account === single);
    if (query.includes("slot = 'settle'") && (table === "paper_runs" || !batch || values[3] === false)) rows = rows.filter((r) => r.slot === "settle");
    const newest = batch ? values[0] !== false : query.includes("DESC");
    rows.sort((a, b) => {
      const group = batch ? String(a.account).localeCompare(String(b.account)) : 0;
      if (group) return group;
      if (table === "paper_positions") return String(a.ticker).localeCompare(String(b.ticker));
      if (table === "paper_accounts") return String(a.account).localeCompare(String(b.account));
      const key = table === "paper_orders" ? "created_at" : "trade_date";
      const order = String(a[key]).localeCompare(String(b[key])) || String(a.slot).localeCompare(String(b.slot));
      return newest ? -order : order;
    });
    if (query.includes("ROW_NUMBER()")) {
      expect(query).toContain("PARTITION BY account");
      expect(query).toContain("account = ANY(?::text[])");
      expect(query).toContain("ORDER BY account, arena_rank");
      const limit = values.at(-1) as number;
      const counts = new Map<unknown, number>();
      rows = rows.filter((r) => { const count = (counts.get(r.account) ?? 0) + 1; counts.set(r.account, count); return count <= limit; });
    } else if (query.includes("DISTINCT ON")) {
      const seen = new Set();
      rows = rows.filter((r) => { if (seen.has(r.account)) return false; seen.add(r.account); return true; });
    } else if (query.includes("LIMIT")) rows = rows.slice(0, Number(values[1]));
    return rows;
  });
});

async function legacyArena() {
  const accounts = await listAccounts();
  return buildArenaView(await Promise.all(accounts.map(async (a) => {
    const [metrics, nav, [latestNav], orders, positions] = await Promise.all([
      computeMetricsForAccount(a.account).catch(() => null), getSettleNavSeries(a.account, 400, true),
      getNavSeries(a.account, 1), listOrders(a.account, 100), getPositions(a.account),
    ]);
    return { ...a, metrics, nav, latestNav: latestNav ?? null, orders, positions };
  })));
}

async function storeMetrics() {
  for (const account of PAPER_ACCOUNTS) {
    tables.paper_runs.push({ account, id: account, slot: "settle", trade_date: "2026-10-01", started_at: "2026-10-01", detail: { metrics: await computeMetricsForAccount(account) } });
  }
}

describe("batched arena loader", () => {
  it("matches the legacy response and reduces 79 queries to six with stored metrics", async () => {
    await storeMetrics();
    sql.mockClear();
    const expected = await legacyArena();
    expect(sql).toHaveBeenCalledTimes(79);
    sql.mockClear();
    expect(await loadArena()).toEqual(expected);
    expect(sql).toHaveBeenCalledTimes(6);
  });

  it("matches legacy computation with nine queries when all metrics are missing", async () => {
    const expected = await legacyArena();
    sql.mockClear();
    expect(await loadArena()).toEqual(expected);
    expect(sql).toHaveBeenCalledTimes(9);
  });

  it("only falls back for invalid latest settle metrics, never an older valid run", async () => {
    await storeMetrics();
    const expected = await legacyArena();
    tables.paper_runs.push({ ...tables.paper_runs[0], trade_date: "2026-10-02", detail: { metrics: { cagr: 123 } } });
    sql.mockClear();
    expect(await loadArena()).toEqual(expected);
    expect(sql).toHaveBeenCalledTimes(9);
    const fallbackCalls = sql.mock.calls.slice(6);
    expect(fallbackCalls.every((call) => call.some((v) => Array.isArray(v) && v.join() === "t1"))).toBe(true);
  });

  it("returns an empty view with only the account query when unseeded", async () => {
    tables.paper_accounts = [];
    expect(await loadArena()).toEqual(buildArenaView([]));
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("isolates a failing account's fallback computation in the shared page/API loader", async () => {
    for (const order of tables.paper_orders) {
      if (order.account === "t1") order.ticker = `FAIL-${order.ticker}`;
    }
    const compute = metricsCore.computeAccountMetrics;
    const computeSpy = vi.spyOn(metricsCore, "computeAccountMetrics").mockImplementation((...args) => {
      if (args[2].some((order) => order.ticker.startsWith("FAIL-"))) {
        throw new Error("one account cannot be scored");
      }
      return compute(...args);
    });
    const expected = await legacyArena();
    computeSpy.mockClear();
    sql.mockClear();

    const arena = await loadArena();
    expect(arena).toEqual(expected);
    expect(arena.rows).toHaveLength(PAPER_ACCOUNTS.length);
    expect(arena.rows.find((row) => row.account === "t1")).toMatchObject({
      sharpeRf0: null, hitRatePct: null, closedPositions: 0, turnoverPct: null,
      nav: 10404, positionsN: 1,
    });
    expect(arena.rows.filter((row) => row.account !== "t1").every((row) =>
      row.sharpeRf0 !== null && row.closedPositions === 60)).toBe(true);
    expect(arena.curves.t1).toHaveLength(400);
    expect(arena.trades.some((trade) => trade.account === "t1")).toBe(true);
    expect(computeSpy).toHaveBeenCalledTimes(PAPER_ACCOUNTS.length);
    expect(sql).toHaveBeenCalledTimes(9);
  });

  it("retains graceful degradation when batch reads fail", async () => {
    sql.mockImplementation(async (strings: TemplateStringsArray) => {
      if (strings.join().includes("paper_accounts")) return tables.paper_accounts;
      throw new Error("unavailable");
    });
    const expected = buildArenaView(PAPER_ACCOUNTS.map((account) => ({
      account, label: account, seat: null, cash: 5000,
      metrics: metricsCore.computeAccountMetrics([], [], [], null, null, null, null),
      nav: [], latestNav: null, orders: [], positions: [],
    })));
    expect(await loadArena()).toEqual(expected);
    expect(sql).toHaveBeenCalledTimes(9);
  });

  it("rejects malformed stored metrics and preserves null-valued valid metrics", async () => {
    const metrics = await computeMetricsForAccount("t1");
    expect(readStoredMetrics({ ...metrics, extra: "ignored" })).toEqual(metrics);
    expect(readStoredMetrics({ ...metrics, cagr: null })).toEqual({ ...metrics, cagr: null });
    for (const invalid of [null, [], {}, { ...metrics, cagr: Infinity }, { ...metrics, closedPositions: -1 }, { ...metrics, dayReturn: undefined }]) {
      expect(readStoredMetrics(invalid)).toBeNull();
    }
  });
});
