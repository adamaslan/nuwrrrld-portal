import { describe, expect, it } from "vitest";
import { parseLivePriceRow, parseLivePriceBatch } from "@/lib/shared/live-price";

describe("parseLivePriceRow", () => {
  it("accepts a well-formed row and normalizes the ticker", () => {
    const row = parseLivePriceRow({ ticker: "nvda", price: 123.45, tradedAt: "2026-07-24T17:00:00Z", volume: 10 });
    expect(row).toEqual({ ticker: "NVDA", price: 123.45, tradedAt: "2026-07-24T17:00:00.000Z", volume: 10 });
  });

  it("accepts an epoch-millis tradedAt (Finnhub `t`)", () => {
    const ms = Date.parse("2026-07-24T17:00:00Z");
    const row = parseLivePriceRow({ ticker: "AAPL", price: 200, tradedAt: ms });
    expect(row?.tradedAt).toBe("2026-07-24T17:00:00.000Z");
    expect(row?.volume).toBeNull();
  });

  it("rejects bad price, ticker, or timestamp", () => {
    expect(parseLivePriceRow({ ticker: "NVDA", price: 0, tradedAt: "2026-07-24T17:00:00Z" })).toBeNull();
    expect(parseLivePriceRow({ ticker: "NVDA", price: -5, tradedAt: "2026-07-24T17:00:00Z" })).toBeNull();
    expect(parseLivePriceRow({ ticker: "1BAD", price: 10, tradedAt: "2026-07-24T17:00:00Z" })).toBeNull();
    expect(parseLivePriceRow({ ticker: "NVDA", price: 10, tradedAt: "nope" })).toBeNull();
    expect(parseLivePriceRow(null)).toBeNull();
  });
});

describe("parseLivePriceBatch", () => {
  it("keeps only the latest row per ticker", () => {
    const out = parseLivePriceBatch({
      prices: [
        { ticker: "NVDA", price: 100, tradedAt: "2026-07-24T17:00:00Z" },
        { ticker: "NVDA", price: 101, tradedAt: "2026-07-24T17:00:05Z" }, // newer
        { ticker: "AAPL", price: 200, tradedAt: "2026-07-24T17:00:00Z" },
      ],
    });
    const nvda = out.find((r) => r.ticker === "NVDA");
    expect(out).toHaveLength(2);
    expect(nvda?.price).toBe(101);
  });

  it("drops invalid rows but keeps the valid ones", () => {
    const out = parseLivePriceBatch({
      prices: [
        { ticker: "NVDA", price: 100, tradedAt: "2026-07-24T17:00:00Z" },
        { ticker: "", price: 5, tradedAt: "2026-07-24T17:00:00Z" },
        "garbage",
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].ticker).toBe("NVDA");
  });

  it("returns [] for malformed bodies", () => {
    expect(parseLivePriceBatch(null)).toEqual([]);
    expect(parseLivePriceBatch({})).toEqual([]);
    expect(parseLivePriceBatch({ prices: "no" })).toEqual([]);
  });
});
