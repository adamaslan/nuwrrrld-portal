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
    const now = Date.parse("2026-09-26T12:00:00Z");
    const rows = tradesToLivePrices(["BRK-B", "RTX", "GONE", "ZERO"], {
      "BRK.B": { p: 500.5, s: 100, t: "2026-09-25T20:00:00Z" },
      RTX: { p: 189.365, t: "2026-09-25T20:00:00Z" },
      ZERO: { p: 0, s: 1, t: "2026-09-25T20:00:00Z" },
    }, now);
    expect(rows).toEqual([
      { ticker: "BRK-B", price: 500.5, tradedAt: "2026-09-25T20:00:00Z", volume: 100 },
      { ticker: "RTX", price: 189.365, tradedAt: "2026-09-25T20:00:00Z", volume: null },
    ]);
  });

  it("drops a trade older than the freshness window", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    const rows = tradesToLivePrices(["OLD", "HOLIDAY"], {
      OLD: { p: 10, t: "2026-09-10T20:00:00Z" },
      HOLIDAY: { p: 11, t: "2026-09-22T20:00:00Z" }, // 3.7 days, inside the window
    }, now);
    expect(rows.map((r: { ticker: string }) => r.ticker)).toEqual(["HOLIDAY"]);
  });
});
