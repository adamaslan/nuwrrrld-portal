import { describe, expect, it, vi } from "vitest";
const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: sql }));
import { tickersWithVerdicts } from "@/lib/council-db";

describe("verdict sitemap matches latest page eligibility", () => {
  it("filters the latest row per ticker, rather than any old non-null direction", async () => {
    sql.mockResolvedValue([{ ticker: "AAA" }]);
    expect(await tickersWithVerdicts(2000)).toEqual(["AAA"]);
    const query = sql.mock.calls[0][0].join("?");
    expect(query).toContain("DISTINCT ON (ticker)");
    expect(query).toContain("ORDER BY ticker, created_at DESC");
    expect(query).toContain("WHERE direction IN ('bullish', 'bearish', 'neutral')");
    expect(query).not.toContain("direction IS NOT NULL");
  });
});
