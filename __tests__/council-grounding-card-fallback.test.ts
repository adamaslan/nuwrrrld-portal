/**
 * Council grounding falls back to the stored ticker card when the live gcp3
 * payload is empty, so a seat is never told "no grounding data" for a ticker the
 * portal itself ranked. Every collaborator is mocked; no DB or network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ default: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/council-db", () => ({ recentVerdicts: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/grounding/resolve", () => ({
  resolveGrounding: vi.fn().mockResolvedValue({ tier: null, rules: [] }),
}));
vi.mock("@/lib/shared/signal-lookup", () => ({
  fetchTickerEntry: vi.fn(),
  formatTickerBrief: vi.fn(),
}));
vi.mock("@/lib/ticker-cards-db", () => ({ getCard: vi.fn() }));

import { buildGroundedBrief } from "@/lib/council-grounding";
import { fetchTickerEntry, formatTickerBrief } from "@/lib/shared/signal-lookup";
import { getCard } from "@/lib/ticker-cards-db";

const CARD = {
  ticker: "ADI",
  action: "SELL",
  score: -42,
  dataQuality: 1,
  barDate: "2026-10-09T04:00:00.000Z",
  tokens: { rsi: "neutral", macd: "none", adx: "trending", vol: "normal", confluence: "weak", direction: "bearish" },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchTickerEntry).mockResolvedValue(null);
  vi.mocked(formatTickerBrief).mockReturnValue(null);
  vi.mocked(getCard).mockResolvedValue(null);
});

describe("buildGroundedBrief card fallback", () => {
  it("grounds on the stored card when the live payload is empty", async () => {
    vi.mocked(getCard).mockResolvedValue(CARD);
    const brief = await buildGroundedBrief("Outlook?", "ADI", "T1");
    expect(brief).toContain("Action: SELL");
    expect(brief).toContain("Signal score: -42");
    expect(brief).toContain("dated 2026-10-09");
    expect(brief).not.toContain("No grounding data available");
  });

  it("prefers the live payload when it has one", async () => {
    vi.mocked(fetchTickerEntry).mockResolvedValue({ ai_action: "BUY" });
    vi.mocked(formatTickerBrief).mockReturnValue("Action: BUY");
    const brief = await buildGroundedBrief("Outlook?", "ADI", "T1");
    expect(brief).toContain("LIVE SIGNAL DATA");
    expect(getCard).not.toHaveBeenCalled();
  });

  it("still reports no data when neither source has the ticker", async () => {
    const brief = await buildGroundedBrief("Outlook?", "ZZZZ", "T1");
    expect(brief).toContain("No grounding data available for ZZZZ");
  });
});
