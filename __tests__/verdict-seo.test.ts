import { describe, expect, it } from "vitest";
import {
  buildVerdictSitemapEntries,
  isVerdictIndexable,
  MAX_VERDICT_SITEMAP_ENTRIES,
  verdictDescription,
  verdictTitle,
} from "@/lib/verdict-seo";

const SITE = "https://example.test";
const NOW = new Date("2026-11-13T12:00:00Z");

describe("isVerdictIndexable", () => {
  it("is false with no verdict", () => {
    expect(isVerdictIndexable(null)).toBe(false);
    expect(isVerdictIndexable(undefined)).toBe(false);
  });
  it("is false when the recorded direction is missing or unknown", () => {
    expect(isVerdictIndexable({ direction: null, confidence: "high", horizon: "1w" })).toBe(false);
    expect(isVerdictIndexable({ direction: "sideways", confidence: null, horizon: null })).toBe(false);
  });
  it("is true for a recorded direction", () => {
    expect(isVerdictIndexable({ direction: "bullish", confidence: null, horizon: null })).toBe(true);
  });
});

describe("verdictTitle and verdictDescription", () => {
  it("name the recorded call", () => {
    const v = { direction: "bearish", confidence: "medium", horizon: "1w" };
    expect(verdictTitle("SPY", v)).toBe("$SPY council verdict: SELL");
    const d = verdictDescription("SPY", v);
    expect(d).toContain("SELL");
    expect(d).toContain("medium confidence");
    expect(d).toContain("1w horizon");
  });
  it("omit fields that were never recorded instead of inventing them", () => {
    const d = verdictDescription("SPY", { direction: "neutral", confidence: null, horizon: null });
    expect(d).toContain("HOLD");
    expect(d).not.toMatch(/confidence|horizon/);
  });
  it("say plainly when nothing is recorded", () => {
    expect(verdictTitle("SPY", null)).toBe("$SPY council verdict");
    expect(verdictDescription("SPY", null)).toMatch(/No council verdict has been recorded/);
  });
});

describe("buildVerdictSitemapEntries", () => {
  it("builds one entry per valid ticker", () => {
    const e = buildVerdictSitemapEntries(["spy", "AAPL"], SITE, NOW);
    expect(e.map((x) => x.url)).toEqual([`${SITE}/verdict/SPY`, `${SITE}/verdict/AAPL`]);
  });
  it("drops malformed symbols and collapses duplicates", () => {
    const e = buildVerdictSitemapEntries(["SPY", "spy", "../etc", "1ABC", "", "A B", "BRK.B"], SITE, NOW);
    expect(e.map((x) => x.url)).toEqual([`${SITE}/verdict/SPY`, `${SITE}/verdict/BRK.B`]);
  });
  it("caps the list", () => {
    const many = Array.from({ length: MAX_VERDICT_SITEMAP_ENTRIES + 50 }, (_, i) => {
      const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      return `X${letters[i % 26]}${letters[Math.floor(i / 26) % 26]}${letters[Math.floor(i / 676) % 26]}`;
    });
    expect(buildVerdictSitemapEntries(many, SITE, NOW)).toHaveLength(MAX_VERDICT_SITEMAP_ENTRIES);
  });
  it("returns nothing for no input", () => {
    expect(buildVerdictSitemapEntries([], SITE, NOW)).toEqual([]);
  });
});
