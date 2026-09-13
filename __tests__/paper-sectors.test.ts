import { describe, expect, it } from "vitest";
import { PAPER_SECTORS, isMegaOrLargeCap, sectorFor } from "@/lib/shared/paper-sectors";

describe("sectorFor", () => {
  it("resolves every Core 50 ticker (docs/council-paper-portfolios.md §2.1)", () => {
    const core50 = [
      "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ACN",
      "JPM", "BAC", "BRK.B", "V", "MA", "GS",
      "JNJ", "LLY", "ABBV", "UNH", "TMO", "ABT",
      "AMZN", "TSLA", "HD", "MCD", "NKE",
      "CAT", "HON", "UNP", "GE", "RTX",
      "GOOGL", "META", "NFLX", "DIS", "TMUS",
      "PG", "KO", "COST", "WMT", "PEP",
      "XOM", "CVX", "COP", "SLB",
      "NEE", "SO", "DUK",
      "PLD", "AMT",
      "LIN", "SHW",
    ];
    expect(core50).toHaveLength(50);
    for (const ticker of core50) {
      expect(sectorFor(ticker), `sector for ${ticker}`).not.toBeNull();
    }
  });

  it("returns null for a ticker outside the §2.1 universe", () => {
    expect(sectorFor("ZZZZ_NOT_A_REAL_TICKER")).toBeNull();
  });

  it("classifies macro's ETF extras and the spy control as the ETF pseudo-sector", () => {
    expect(sectorFor("QQQ")).toBe("ETF");
    expect(sectorFor("GLD")).toBe("ETF");
    expect(sectorFor("IVV")).toBe("ETF");
  });

  it("every mapped ticker has a non-empty sector string", () => {
    for (const [ticker, sector] of Object.entries(PAPER_SECTORS)) {
      expect(typeof sector, ticker).toBe("string");
      expect(sector.length, ticker).toBeGreaterThan(0);
    }
  });
});

describe("isMegaOrLargeCap", () => {
  it("is true for every Core 50 ticker", () => {
    expect(isMegaOrLargeCap("AAPL")).toBe(true);
    expect(isMegaOrLargeCap("BRK.B")).toBe(true);
  });

  it("is true for ETFs", () => {
    expect(isMegaOrLargeCap("QQQ")).toBe(true);
    expect(isMegaOrLargeCap("IVV")).toBe(true);
  });

  it("is false for a non-Core-50, non-ETF extra", () => {
    expect(isMegaOrLargeCap("PLTR")).toBe(false);
    expect(isMegaOrLargeCap("COIN")).toBe(false);
  });
});
