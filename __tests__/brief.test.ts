import { describe, it, expect } from "vitest";
import { buildBriefPrompt } from "@/app/api/brief/route";
import { mapSignalsToHoldFold } from "@/lib/shared/holdfold-map";

// Shape captured from a live GET /signals against the gcp3 backend.
const RAW_SIGNALS = {
  updated: "2026-07-30T12:00:00Z",
  symbols: {
    NVDA: {
      symbol: "NVDA", ai_action: "BUY", ai_confidence: "HIGH", industry: "Semiconductors",
      price: 182.4, "52w_high": 195.0, "52w_low": 86.6,
      indicators: { rsi: 61.2, macd: 1.4, adx: 27.8 },
      returns: { "1d": 1.2, "1m": 8.4 },
      signals: [{ signal: "MACD cross", strength: "STRONG", detail: "bullish", category: "momentum" }],
      ai_summary: "Momentum intact.", ai_outlook: "Constructive.",
    },
    INTC: {
      symbol: "INTC", ai_action: "SELL", ai_confidence: "MEDIUM", industry: "Semiconductors",
      price: 21.1, "52w_high": 45.0, "52w_low": 18.5,
      indicators: { rsi: 38.0, macd: -0.6, adx: 19.0 },
      returns: { "1d": -0.8 }, signals: [], ai_summary: "", ai_outlook: "",
    },
    KO: {
      symbol: "KO", ai_action: "HOLD", ai_confidence: "LOW", industry: "Beverages",
      price: 62.0, "52w_high": 73.0, "52w_low": 57.0,
      indicators: {}, returns: {}, signals: [], ai_summary: "", ai_outlook: "",
    },
  },
};

const MARKET = {
  brief: {
    market_tone: "bullish",
    summary: "Markets are bullish today with an average move of +1.89% across major indices.",
    indices: {
      "S&P 500": { symbol: "SPY", price: 736.02, change_pct: 0.9 },
      "Nasdaq 100": { symbol: "QQQ", price: 674.42, change_pct: 1.92 },
    },
  },
};

describe("mapSignalsToHoldFold", () => {
  it("derives verdicts from a /signals payload", () => {
    const p = mapSignalsToHoldFold(RAW_SIGNALS)!;
    expect(p.total).toBe(3);
    expect(p.holdCount).toBe(1);
    expect(p.foldCount).toBe(1);
    expect(p.neutralCount).toBe(1);
  });

  it("sorts HOLD EM first, then FOLD EM, then NEUTRAL", () => {
    const p = mapSignalsToHoldFold(RAW_SIGNALS)!;
    expect(p.verdicts.map(v => v.ticker)).toEqual(["NVDA", "INTC", "KO"]);
    expect(p.verdicts[0].verdict).toBe("HOLD EM");
    expect(p.verdicts[1].verdict).toBe("FOLD EM");
  });

  it("returns null for a payload without a symbols map", () => {
    expect(mapSignalsToHoldFold({ verdicts: [] })).toBeNull();
    expect(mapSignalsToHoldFold(null)).toBeNull();
    expect(mapSignalsToHoldFold({ symbols: [] })).toBeNull();
  });
});

describe("buildBriefPrompt", () => {
  const verdicts = mapSignalsToHoldFold(RAW_SIGNALS)!.verdicts;

  it("grounds the prompt in real indices and verdicts", () => {
    const p = buildBriefPrompt("pro", MARKET, verdicts);
    expect(p).toContain("Market tone: bullish");
    expect(p).toContain("S&P 500 (SPY): 736.02 +0.90%");
    expect(p).toContain("Nasdaq 100 (QQQ): 674.42 +1.92%");
    expect(p).toContain("NVDA: HOLD EM (HIGH)");
    expect(p).toContain("User tier: pro");
  });

  // The original bug: on upstream failure the prompt still emitted
  // "Index data unavailable" / "No verdicts available" and told the model to
  // cite specifics, so it wrote four sentences about the missing data.
  it("omits sections that were not fetched rather than announcing them", () => {
    const p = buildBriefPrompt("pro", null, verdicts);
    expect(p).not.toContain("Index data unavailable");
    expect(p).not.toContain("Market tone: unknown");
    expect(p).not.toContain("No market summary available");
    expect(p).not.toContain("Indices:");
    expect(p).toContain("NVDA: HOLD EM (HIGH)");
    expect(p).toContain("cite only the Hold/Fold verdicts shown");
  });

  it("drops the verdict sentence from the format when no verdicts exist", () => {
    const p = buildBriefPrompt("pro", MARKET, null);
    expect(p).not.toContain("No verdicts available");
    expect(p).not.toContain("Top Hold/Fold verdicts");
    expect(p).toContain("Standout index move");
    expect(p).toContain("cite only the index/market data shown");
  });

  it("names both sources when both are present", () => {
    const p = buildBriefPrompt("pro", MARKET, verdicts);
    expect(p).toContain("cite only the index/market data and Hold/Fold verdicts shown");
    expect(p).toContain("Standout verdict or signal");
  });
});
