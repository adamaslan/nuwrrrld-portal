/**
 * Phase 2.4 — crypto pairs must be rejected at registration. The card
 * pipeline's horizons and followed-tickers trading-day math assume a Mon–Fri
 * session calendar; a 24/7 asset produces wrong days_held on every horizon, and
 * BTC-USD-shaped symbols also 400 the whole Alpaca chunk they land in.
 */
import { describe, expect, it } from "vitest";

import { isCryptoShaped } from "@/lib/shared/signal-policy";

describe("isCryptoShaped", () => {
  it("flags the pairs behind the whole-chunk-400 incident", () => {
    for (const t of ["BTC-USD", "ETH-USD", "DOGE-USD", "SOL-USD"]) {
      expect(isCryptoShaped(t), t).toBe(true);
    }
  });

  it("flags stablecoin and fiat settlement suffixes", () => {
    expect(isCryptoShaped("USDC-USD")).toBe(true);
    expect(isCryptoShaped("ADA-USDT")).toBe(true);
    expect(isCryptoShaped("btc-eur")).toBe(true); // case-insensitive
  });

  it("does not flag equities, ETFs or real share/preferred classes", () => {
    for (const t of ["AAPL", "BRK.B", "BRK-B", "BF-B", "SCHW-PD", "SPY", "TQQQ"]) {
      expect(isCryptoShaped(t), t).toBe(false);
    }
  });

  it("is safe on non-string input", () => {
    expect(isCryptoShaped(null)).toBe(false);
    expect(isCryptoShaped(undefined)).toBe(false);
    expect(isCryptoShaped(42)).toBe(false);
  });
});
