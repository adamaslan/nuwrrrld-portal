import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const { bipolarCards, getCard, fetchTickerEntry } = vi.hoisted(() => ({ bipolarCards: vi.fn(), getCard: vi.fn(), fetchTickerEntry: vi.fn() }));
vi.mock("@/lib/ticker-cards-db", () => ({ bipolarCards, getCard }));
vi.mock("@/lib/shared/signal-lookup", () => ({ fetchTickerEntry }));
import { getStoredSignals, getStoredHoldFold, getTickerVerdict } from "@/app/dashboard/holdfold/stored-signals";
import { adaptLiveSignals } from "@/lib/digest";
const card = { ticker: "TEST", action: "SELL", horizon: "t1", score: -42, scoreVersion: "v1", computedAt: "2026-10-01T00:00:00Z",
  tokens: { rsi: "overbought", macd: "bearish_cross", adx: "trending", vol: "high", confluence: "strong", direction: "bearish", horizon: "t1" } };
describe("bounded page signal reads", () => {
  beforeEach(() => { vi.clearAllMocks(); bipolarCards.mockResolvedValue([card]); });
  it("reads a bounded balanced feed and preserves action, score, regimes and source time", async () => {
    const raw = await getStoredSignals();
    expect(bipolarCards).toHaveBeenCalledExactlyOnceWith("t1", 24, "stock");
    const signal = adaptLiveSignals(raw).signals[0];
    expect(signal).toMatchObject({ ticker: "TEST", direction: "bearish", confidence: "high", score: -42, generatedAt: card.computedAt });
    expect(signal.indicators).toContain("rsi: overbought");
    expect(raw.symbols.TEST).not.toHaveProperty("price");
  });
  it("does not fabricate numeric measurements from discretized tokens", async () => {
    const { verdicts } = await getStoredHoldFold();
    expect(verdicts[0]).toMatchObject({ verdict: "FOLD EM", rsi: null, macd: null, adx: null, confidenceLabel: "HIGH" });
    expect(Number.isNaN(verdicts[0].price)).toBe(true);
    expect(Number.isNaN(verdicts[0].confidence)).toBe(true);
  });
  it("looks up only the selected ticker and retains real numeric measurements", async () => {
    fetchTickerEntry.mockResolvedValue({ ai_action: "BUY", price: 123.45, indicators: { rsi: 27 }, updated: card.computedAt });
    expect(await getTickerVerdict(" test ")).toMatchObject({ ticker: "TEST", price: 123.45, rsi: 27 });
    expect(fetchTickerEntry).toHaveBeenCalledExactlyOnceWith("TEST");
    expect(bipolarCards).not.toHaveBeenCalled();
    fetchTickerEntry.mockResolvedValue(null);
    expect(await getTickerVerdict("MISSING")).toBeNull();
  });
  it("empty stored feeds stay empty and page sources never download the full signals endpoint", async () => {
    bipolarCards.mockResolvedValue([]);
    expect(adaptLiveSignals(await getStoredSignals()).signals).toEqual([]);
    for (const path of ["app/dashboard/page.tsx", "app/dashboard/holdfold/page.tsx", "app/dashboard/holdfold/[ticker]/page.tsx", "app/signals/page.tsx"]) {
      expect(readFileSync(path, "utf8")).not.toContain("${MCP_URL}/signals");
    }
  });
});
