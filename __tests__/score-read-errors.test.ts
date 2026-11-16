import { beforeEach, describe, expect, it, vi } from "vitest";
const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: sql }));
import { getAllScores } from "@/lib/followed-tickers-db";
describe("score-read error propagation", () => {
  beforeEach(() => { sql.mockReset(); });
  it("preserves existing fail-soft callers", async () => {
    sql.mockRejectedValue(new Error("offline"));
    expect(await getAllScores()).toEqual([]);
  });
  it("lets availability-aware callers distinguish failure", async () => {
    sql.mockRejectedValue(new Error("offline"));
    await expect(getAllScores({ throwOnError: true })).rejects.toThrow("offline");
  });
});
