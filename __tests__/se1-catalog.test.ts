import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LEVELS, FAMILIES, SEED_CARDS, computeGaps, filterCards, findCard, isScanId, splitCitations, totalPlanned,
} from "@/lib/shared/se1-catalog";
import { WAVE0_FEATURES, c0Share, formatProvenance, missingProvenance } from "@/lib/shared/ai-features";

describe("se1 catalog", () => {
  it("family allocation sums to the plan's 200", () => {
    expect(totalPlanned()).toBe(200);
  });

  it("seed cards are spec/E0 with no invented measurements, and valid IDs", () => {
    for (const c of SEED_CARDS) {
      expect(c.status).toBe("spec");
      expect(c.evidence_level).toBe("E0");
      expect(isScanId(c.id)).toBe(true);
      expect(c.id.split(".")[1]).toBe(c.family);
      expect(c.caveats.length).toBeGreaterThan(0);
    }
  });

  it("related-scan links resolve to seed cards", () => {
    for (const c of SEED_CARDS) {
      for (const id of [...c.composes_with, ...c.contradicts]) expect(findCard(SEED_CARDS, id)).toBeDefined();
    }
  });

  it("splitCitations separates scan IDs from prose (A3)", () => {
    const parts = splitCitations("See se1.trend.golden_cross_recency, but se1.trend.exit_close_under_200 disagrees.");
    expect(parts.filter((p) => p.type === "scan").map((p) => (p as { id: string }).id)).toEqual([
      "se1.trend.golden_cross_recency",
      "se1.trend.exit_close_under_200",
    ]);
    expect(parts.map((p) => (p.type === "text" ? p.text : p.id)).join("")).toBe(
      "See se1.trend.golden_cross_recency, but se1.trend.exit_close_under_200 disagrees.",
    );
    expect(splitCitations("se1.bogus.thing and plain text")).toEqual([{ type: "text", text: "se1.bogus.thing and plain text" }]);
  });

  it("evidence filter keeps only cards at or above the level (A7)", () => {
    expect(filterCards(SEED_CARDS, { minEvidence: "E0" })).toHaveLength(SEED_CARDS.length);
    expect(filterCards(SEED_CARDS, { minEvidence: "E1" })).toHaveLength(0);
    expect(filterCards(SEED_CARDS, { family: "vol" }).map((c) => c.id)).toEqual(["se1.vol.breakout_volume_confirm"]);
    expect(filterCards(SEED_CARDS, { query: "GOLDEN" })).toHaveLength(1);
    expect(EVIDENCE_LEVELS).toHaveLength(5);
  });

  it("gap list blocks exactly the families that need an unbuilt feed (G6)", () => {
    const gaps = computeGaps();
    const blocked = gaps.filter((g) => g.missingFeeds.length > 0).map((g) => g.family.code);
    expect(blocked).toEqual(expect.arrayContaining(["news", "event", "fund", "valu", "own", "macro", "eng"]));
    expect(blocked).not.toContain("trend");
    expect(gaps).toHaveLength(FAMILIES.length);
    expect(computeGaps(SEED_CARDS, ["alpaca_bars", "alpaca_news"]).find((g) => g.family.code === "news")?.missingFeeds).toEqual([]);
  });
});

describe("ai-features registry", () => {
  it("has unique IDs, all P0, and is C0-only for Wave 0", () => {
    const ids = WAVE0_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(WAVE0_FEATURES).toHaveLength(11);
    expect(WAVE0_FEATURES.every((f) => f.se1 === "P0" && f.cost === "C0")).toBe(true);
    expect(c0Share()).toBe(1);
  });

  it("provenance fails closed on any missing field (G9)", () => {
    const full = { source: "se1 plan §4", feed: "alpaca_bars", as_of: "2026-11-08", scan_version: "1.0.0" };
    expect(formatProvenance(full)).toContain("scan v1.0.0");
    expect(formatProvenance({ ...full, as_of: " " })).toBeNull();
    expect(missingProvenance({ source: "x" })).toEqual(["feed", "as_of", "scan_version"]);
  });
});
