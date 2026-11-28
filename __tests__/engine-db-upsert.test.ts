import { describe, expect, it, vi } from "vitest";

/**
 * upsertBars sends one transaction: a transaction-local statement_timeout, then
 * the change-only upsert. The SQL itself (each column, no leak past COMMIT) is
 * proven against a real Postgres in engine-db.pg.test.ts.
 */
const sqlCalls = vi.hoisted(() => ({ transactions: [] as string[][] }));
vi.mock("@/lib/db", () => {
  const tag = (strings: TemplateStringsArray) => ({ text: strings.join("?") });
  tag.transaction = async (queries: Array<{ text: string }>) => {
    sqlCalls.transactions.push(queries.map((q) => q.text));
    return [];
  };
  return { default: tag };
});

const { upsertBars } = await import("@/lib/engine-db");

describe("upsertBars", () => {
  it("sends SET LOCAL statement_timeout and the change-only upsert as one transaction", async () => {
    const row = { ticker: "AAA", barDate: "2026-11-25", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
    expect(await upsertBars([row], { feed: "sip", adjustment: "split", source: "alpaca" })).toBe(1);
    const [tx] = sqlCalls.transactions;
    expect(tx).toHaveLength(2);
    expect(tx[0]).toBe("SET LOCAL statement_timeout = '5min'");
    expect(tx[1]).toMatch(/INSERT INTO daily_bars[\s\S]*fetched_at = now\(\)[\s\S]*IS DISTINCT FROM/);
  });

  it("sends nothing for an empty batch", async () => {
    sqlCalls.transactions.length = 0;
    expect(await upsertBars([], { feed: "sip", adjustment: "split", source: "alpaca" })).toBe(0);
    expect(sqlCalls.transactions).toHaveLength(0);
  });
});
