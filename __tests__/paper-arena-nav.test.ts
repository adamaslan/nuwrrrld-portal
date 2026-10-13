import { expect, it, vi } from "vitest";
import { getSettleNavSeries } from "@/lib/paper-db";

const sql = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ default: sql }));

it("returns the newest 400 settle marks ascending without changing default callers", async () => {
  const marks = Array.from({ length: 401 }, (_, i) => ({
    account: "t1", slot: "settle", trade_date: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    cash: 0, positions_mv: 10000 + i, nav: 10000 + i, positions_n: 1, turnover: 0,
  }));
  sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    expect(query).toContain("slot = 'settle'");
    expect(query).toMatch(/ORDER BY trade_date (ASC|DESC) LIMIT/);
    return (query.includes("DESC") ? [...marks].reverse() : marks).slice(0, Number(values[1]));
  });
  expect((await getSettleNavSeries("t1", 400, true)).map((p) => p.tradeDate))
    .toEqual(marks.slice(1).map((m) => m.trade_date.slice(0, 10)));
  expect((await getSettleNavSeries("t1", 400)).map((p) => p.tradeDate))
    .toEqual(marks.slice(0, 400).map((m) => m.trade_date.slice(0, 10)));
});
