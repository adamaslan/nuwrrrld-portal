import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const mocks = vi.hoisted(() => ({ sql: vi.fn(), card: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: mocks.sql }));
vi.mock("@/lib/ticker-cards-db", () => ({ getCard: mocks.card }));
import { getAggregateTrackRecord } from "@/lib/track-record";
import { getCouncilSample } from "@/app/dashboard/holdfold/council-sample";
import { GET } from "@/app/api/council/sample/route";

beforeEach(() => { vi.clearAllMocks(); mocks.card.mockResolvedValue(null); });
const aggregate = { total_hits: 70, total_calls: 100, ticker_count: 10, oldest_computed_at: new Date().toISOString() };
describe("public track record", () => {
  it("shows a sufficiently broad and fresh sample", async () => {
    mocks.sql.mockResolvedValue([aggregate]);
    expect(await getAggregateTrackRecord()).toEqual({ hitRatePct: 70, totalCalls: 100 });
  });
  it.each([
    { total_calls: 99 }, { ticker_count: 5 },
    { oldest_computed_at: "2026-07-24" }, { oldest_computed_at: "invalid" },
    { total_hits: 101 },
  ])("hides inadequate evidence %j", async (patch) => {
    mocks.sql.mockResolvedValue([{ ...aggregate, ...patch }]);
    expect(await getAggregateTrackRecord()).toBeNull();
  });
});
describe("council sample reads", () => {
  it("reads a persisted sample without model or upstream calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mocks.sql.mockResolvedValue([{ payload: { ticker: "MOO", shortTerm: { answer: "short" }, longTerm: { answer: "long" } }, generated_at: aggregate.oldest_computed_at }]);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("s-maxage=300");
    expect((await response.json()).source).toBe("precomputed");
    expect(mocks.card).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
  it("grounds the fallback in both stored horizons and labels it honestly", async () => {
    mocks.sql.mockResolvedValue([]);
    mocks.card.mockImplementation(async (_ticker, horizon) => ({ isFinal: true, dataQuality: 1, missingFields: [], barDate: new Date().toISOString().slice(0, 10), computedAt: aggregate.oldest_computed_at, action: horizon === "t1" ? "BUY" : "SELL", score: 20, tokens: { rsi: "neutral", macd: "none", adx: "ranging" } }));
    const sample = await getCouncilSample();
    expect(sample?.shortTerm.answer).toContain("BUY");
    expect(sample?.longTerm.answer).toContain("SELL");
    expect(sample?.shortTerm.answer).toContain("not an AI council");
    expect(mocks.card.mock.calls).toEqual([["MOO", "t1"], ["MOO", "t2"]]);
  });
  it("does not invent a sample when stored grounding is missing", async () => {
    mocks.sql.mockRejectedValue(new Error("offline"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects stale and incomplete grounding", async () => {
    mocks.sql.mockResolvedValue([]);
    mocks.card.mockResolvedValue({ isFinal: false, dataQuality: 0.5, missingFields: ["rsi"], barDate: "2026-07-24" });
    expect(await getCouncilSample()).toBeNull();
  });
});
it("keeps landing data reads inside the streamed content boundary", () => {
  const source = readFileSync("app/page.tsx", "utf8");
  const home = source.slice(source.indexOf("export default async function Home"), source.indexOf("async function LandingContent"));
  expect(home).toContain("<Suspense");
  expect(home).not.toContain("await fetchLandingData");
  expect(source).not.toContain("/api/council/sample");
  expect(source).not.toContain("MCP_URL");
});
