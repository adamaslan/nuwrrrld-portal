/**
 * Phase 2.3 — the CSV at ~/code/signals-app/seed/universe_symbols.csv is
 * yfinance-shaped (hyphenated share classes: BRK-B, BF-B). Alpaca, the portal's
 * vendor, wants dots (BRK.B, BF.B). seed-signals-universe.mjs normalizes at
 * ingest because the CSV is correct for its own vendor.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script, no type declarations
import { normalizeToAlpaca } from "@/scripts/seed-signals-universe.mjs";

describe("normalizeToAlpaca", () => {
  it("rewrites a single-letter share class from hyphen to dot", () => {
    expect(normalizeToAlpaca("BRK-B")).toBe("BRK.B");
    expect(normalizeToAlpaca("BF-B")).toBe("BF.B");
  });

  it("leaves a plain ticker untouched", () => {
    expect(normalizeToAlpaca("AAPL")).toBe("AAPL");
    expect(normalizeToAlpaca("MSFT")).toBe("MSFT");
  });

  it("leaves an already-dotted class untouched", () => {
    expect(normalizeToAlpaca("BRK.B")).toBe("BRK.B");
  });

  it("does NOT touch preferred-share notation — that is a different scheme", () => {
    // SCHW-PD is Alpaca's SCHW.PR.D, not SCHW.PD — a separator swap would be wrong.
    expect(normalizeToAlpaca("SCHW-PD")).toBe("SCHW-PD");
  });
});
