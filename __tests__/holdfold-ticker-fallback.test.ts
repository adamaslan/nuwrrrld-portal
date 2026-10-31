/**
 * getTickerVerdict — the Hold/Fold ticker detail page's data source.
 *
 * The index (getStoredHoldFold) and the dashboard's TOP MOVERS link to
 * /dashboard/holdfold/<ticker> from the stored-card feed, while the detail
 * page first tries the live/cache per-ticker lookup (signal_cache + gcp3).
 * Those are different data planes: a ticker with a fresh stored card can have
 * no signal_cache row, and before the fallback its detail page 404'd straight
 * from the index's own links.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchTickerEntry: vi.fn(),
  getCard: vi.fn(),
}));

vi.mock("@/lib/shared/signal-lookup", () => ({ fetchTickerEntry: mocks.fetchTickerEntry }));
vi.mock("@/lib/ticker-cards-db", () => ({ getCard: mocks.getCard, bipolarCards: vi.fn() }));

function storedCard(overrides: Record<string, unknown> = {}) {
  return {
    ticker: "STX",
    universe: "stock",
    horizon: "t1",
    stateKey: "state-1",
    taxonomyVersion: "v1",
    tokens: { direction: "bullish", confluence: "strong", horizon: "t1" },
    score: 1.5,
    scoreVersion: "sv1",
    action: "BUY",
    dataQuality: 0.95,
    missingFields: [],
    source: "test",
    sourceRunId: null,
    barDate: "2026-10-29",
    computedAt: "2026-10-30T02:00:00.000Z",
    isFinal: true,
    ...overrides,
  };
}

describe("getTickerVerdict", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the live/cache entry when one exists", async () => {
    mocks.fetchTickerEntry.mockResolvedValue({
      symbol: "STX",
      ai_action: "SELL",
      ai_confidence: "LOW",
      updated: "2026-10-30T13:00:00.000Z",
    });
    const { getTickerVerdict } = await import("@/app/dashboard/holdfold/stored-signals");

    const v = await getTickerVerdict("stx");
    expect(v?.ticker).toBe("STX");
    expect(v?.verdict).toBe("FOLD EM");
    expect(mocks.getCard).not.toHaveBeenCalled();
  });

  it("falls back to the stored card when the live lookup misses", async () => {
    mocks.fetchTickerEntry.mockResolvedValue(null);
    mocks.getCard.mockResolvedValue(storedCard());
    const { getTickerVerdict } = await import("@/app/dashboard/holdfold/stored-signals");

    const v = await getTickerVerdict("STX");
    expect(mocks.getCard).toHaveBeenCalledWith("STX", "t1");
    expect(v?.ticker).toBe("STX");
    expect(v?.verdict).toBe("HOLD EM");
    expect(v?.confidenceLabel).toBe("HIGH");
    expect(v?.updatedAt).toBe("2026-10-30T02:00:00.000Z");
  });

  it("returns null when neither plane has the ticker", async () => {
    mocks.fetchTickerEntry.mockResolvedValue(null);
    mocks.getCard.mockResolvedValue(null);
    const { getTickerVerdict } = await import("@/app/dashboard/holdfold/stored-signals");

    expect(await getTickerVerdict("STX")).toBeNull();
  });

  it("does not fall back to a card the index would have filtered out", async () => {
    mocks.fetchTickerEntry.mockResolvedValue(null);
    mocks.getCard.mockResolvedValue(storedCard({ dataQuality: 0.5 }));
    const { getTickerVerdict } = await import("@/app/dashboard/holdfold/stored-signals");

    expect(await getTickerVerdict("STX")).toBeNull();
  });

  it("rejects an ETF card the stock-universe index would never show", async () => {
    mocks.fetchTickerEntry.mockResolvedValue(null);
    mocks.getCard.mockResolvedValue(storedCard({ universe: "etf" }));
    const { getTickerVerdict } = await import("@/app/dashboard/holdfold/stored-signals");

    expect(await getTickerVerdict("STX")).toBeNull();
  });

  it("rejects malformed tickers before any lookup", async () => {
    const { getTickerVerdict } = await import("@/app/dashboard/holdfold/stored-signals");

    expect(await getTickerVerdict("not a ticker!")).toBeNull();
    expect(mocks.fetchTickerEntry).not.toHaveBeenCalled();
    expect(mocks.getCard).not.toHaveBeenCalled();
  });
});
