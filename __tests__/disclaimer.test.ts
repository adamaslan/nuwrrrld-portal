import { describe, expect, it } from "vitest";
import { djb2, DISCLAIMER_HASH, DISCLAIMER_TEXT, DISCLAIMER_VERSION } from "@/lib/disclaimer";
import { analyzeCacheKey } from "@/lib/shared/analyze-policy";

describe("djb2", () => {
  it("is deterministic", () => {
    expect(djb2("hello")).toBe(djb2("hello"));
  });

  it("changes when the input changes", () => {
    expect(djb2("hello")).not.toBe(djb2("hello!"));
  });
});

describe("DISCLAIMER_HASH", () => {
  it("is derived from the current text and version", () => {
    expect(DISCLAIMER_HASH).toBe(djb2(DISCLAIMER_TEXT + DISCLAIMER_VERSION));
  });

  it("would change if the disclaimer text changed — the whole point of the hash", () => {
    const hypotheticalNewText = DISCLAIMER_TEXT + " Extra clause.";
    expect(djb2(hypotheticalNewText + DISCLAIMER_VERSION)).not.toBe(DISCLAIMER_HASH);
  });
});

describe("analyzeCacheKey", () => {
  it("is stable for identical request shapes", () => {
    const req = { symbol: "AAPL", period: "3mo", assetType: "stock", riskProfile: "moderate" };
    expect(analyzeCacheKey(req)).toBe(analyzeCacheKey({ ...req }));
  });

  it("differs when period differs", () => {
    const base = { symbol: "AAPL", period: "3mo", assetType: "stock", riskProfile: "moderate" };
    expect(analyzeCacheKey(base)).not.toBe(analyzeCacheKey({ ...base, period: "1y" }));
  });

  it("excludes position data by design — not part of the input shape at all", () => {
    // analyzeCacheKey's signature has no position fields; this test documents
    // that omission is intentional (see lib/analyze-cache-db.ts header).
    const req = { symbol: "AAPL", period: "3mo", assetType: "stock", riskProfile: "moderate" };
    const withPosition = { ...req, positionQty: 10 };
    expect(analyzeCacheKey(withPosition)).toBe(analyzeCacheKey(req));
  });
});
