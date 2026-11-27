import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: mocks.sql }));
import { resolveGrounding } from "@/lib/grounding/resolve";

function rows(trader_filter: string | null) {
  return Array.from({ length: 3 }, (_, i) => ({
    rule_text: `Rule ${i}`, quote: `Quote ${i}`, chunk_id: `chunk-${i}`,
    source_file: i === 0 ? "source-a" : "source-b", tags: [], confidence: 1,
    direction: "bullish", corpus_version: "fixture", taxonomy_version: "TAXONOMY_V1", trader_filter,
  }));
}

describe("Tier 0 trader filter", () => {
  beforeEach(() => mocks.sql.mockReset().mockResolvedValue([]));

  it.each(["T1", "T2"])("allows ALL-trader rules for %s without dropping to search", async (trader) => {
    mocks.sql.mockResolvedValueOnce(rows("ALL"));
    const result = await resolveGrounding("fixture", { direction: "bullish" }, "t1", "AAA", trader);
    expect(result.tier).toBe(0);
    expect(result.rules).toHaveLength(3);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it.each(["T1", null])("retains compatible rules with filter %s", async (filter) => {
    mocks.sql.mockResolvedValueOnce(rows(filter));
    expect((await resolveGrounding("fixture", {}, "t1", "AAA", "T1")).tier).toBe(0);
  });

  it("still requires enough rules and diverse sources for ALL", async () => {
    mocks.sql.mockResolvedValueOnce(rows("ALL").slice(0, 2));
    expect((await resolveGrounding("fixture", {}, "t1", "AAA", "T1")).tier).toBeNull();
    mocks.sql.mockResolvedValueOnce(rows("ALL").map((r) => ({ ...r, source_file: "same-source" })));
    expect((await resolveGrounding("fixture", {}, "t1", "AAA", "T1")).tier).toBeNull();
  });

  it("does not serve T2-only rules to T1", async () => {
    mocks.sql.mockResolvedValueOnce(rows("T2"));
    expect((await resolveGrounding("fixture", {}, "t1", "AAA", "T1")).tier).toBeNull();
  });
});
