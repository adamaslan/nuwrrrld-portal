import { describe, expect, it } from "vitest";
import {
  buildVerdictSitemapEntries,
  isVerdictIndexable,
  MAX_VERDICT_SITEMAP_ENTRIES,
  recordedDateLabel,
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
  it("name the recorded call, marked as a record so it never reads as current", () => {
    const v = { direction: "bearish", confidence: "medium", horizon: "1w" };
    expect(verdictTitle("SPY", v)).toBe("$SPY council verdict: SELL (recorded)");
    const d = verdictDescription("SPY", v);
    expect(d).toContain("SELL");
    expect(d).toContain("medium confidence");
    expect(d).toContain("1w horizon as recorded");
    expect(d).toContain("not current advice");
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

describe("recorded date display", () => {
  const WITH_DATE = {
    direction: "bullish",
    confidence: "high",
    horizon: "1-5d",
    createdAt: "2026-11-12T19:00:00-05:00",
  };

  it("recordedDateLabel formats a parseable timestamp as a UTC date", () => {
    // 19:00 GMT-0500 is 2026-11-13T00:00Z, so the UTC date is the 13th.
    expect(recordedDateLabel(WITH_DATE.createdAt)).toBe("2026-11-13");
    expect(recordedDateLabel("2026-11-12T14:00:00Z")).toBe("2026-11-12");
  });

  it("recordedDateLabel returns null instead of inventing a date", () => {
    expect(recordedDateLabel(null)).toBeNull();
    expect(recordedDateLabel(undefined)).toBeNull();
    expect(recordedDateLabel("")).toBeNull();
    expect(recordedDateLabel("not-a-date")).toBeNull();
  });

  it("title and description carry the record date when it is known", () => {
    expect(verdictTitle("SPY", WITH_DATE)).toBe("$SPY council verdict: BUY (recorded 2026-11-13)");
    const d = verdictDescription("SPY", WITH_DATE);
    expect(d).toContain("Record created 2026-11-13 UTC");
    expect(d).toContain("Stored historical call, not current advice");
  });

  it("no date is shown when the record timestamp is missing or unparsable", () => {
    for (const createdAt of [null, undefined, "not-a-date"] as const) {
      const v = { ...WITH_DATE, createdAt };
      const title = verdictTitle("SPY", v);
      const d = verdictDescription("SPY", v);
      expect(title).toBe("$SPY council verdict: BUY (recorded)");
      expect(title).not.toMatch(/Invalid|NaN|undefined|null/);
      expect(d).not.toMatch(/Invalid|NaN|undefined|null/);
      expect(d).toContain("not current advice");
    }
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
