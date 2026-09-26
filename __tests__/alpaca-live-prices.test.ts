import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs helper, no type declarations
import { toAlpacaSymbol, chunk, tradesToLivePrices } from "../scripts/lib/alpaca-live-prices.mjs";

describe("alpaca live-price helpers", () => {
  it("maps share classes to Alpaca's dot form and leaves others alone", () => {
    expect(toAlpacaSymbol("BRK-B")).toBe("BRK.B");
    expect(toAlpacaSymbol("RTX")).toBe("RTX");
  });

  it("chunks evenly with a short tail", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("maps trades back onto portal tickers and drops unusable ones", () => {
    const rows = tradesToLivePrices(["BRK-B", "RTX", "GONE", "ZERO"], {
      "BRK.B": { p: 500.5, s: 100, t: "2026-09-25T20:00:00Z" },
      RTX: { p: 189.365, t: "2026-09-25T20:00:00Z" },
      ZERO: { p: 0, s: 1, t: "2026-09-25T20:00:00Z" },
    });
    expect(rows).toEqual([
      { ticker: "BRK-B", price: 500.5, tradedAt: "2026-09-25T20:00:00Z", volume: 100 },
      { ticker: "RTX", price: 189.365, tradedAt: "2026-09-25T20:00:00Z", volume: null },
    ]);
  });
});
