import { describe, expect, it } from "vitest";
import { SEED_CARDS, cardProvenance, type CardStatus } from "@/lib/shared/se1-catalog";
import { formatProvenance, LOGIC_FEATURES, WAVE0_FEATURES } from "@/lib/shared/ai-features";

// Regression tests for the skill-pass review of PR #346 (see docs/reports/se1-skill-review-2026-11-08.md).

describe("provenance on unrun scan cards (review finding F1)", () => {
  it("an unrun (spec) card has no as_of, so its footer fails closed", () => {
    for (const card of SEED_CARDS) {
      expect(card.status).toBe("spec");
      expect(cardProvenance(card).as_of).toBe("");
      expect(formatProvenance(cardProvenance(card))).toBeNull();
    }
  });
});

describe("registry honesty for features with no caller (review finding F2)", () => {
  const unwired = ["A3", "B7", "B9", "C4", "D6", "D9", "F2", "J2", "J5"];
  it("features with no route or caller are logic_only, not web_only", () => {
    const all = [...WAVE0_FEATURES, ...LOGIC_FEATURES];
    for (const id of unwired) {
      const f = all.find((x) => x.id === id);
      expect(f, id).toBeDefined();
      expect(f?.status, id).toBe("logic_only");
    }
  });
});


describe("Haiku provenance regression findings", () => {
  it.each<CardStatus>(["spec", "built", "measured", "retired"])("%s status is not a timestamp", (status) => {
    const provenance = cardProvenance({ ...SEED_CARDS[0], status });
    expect(provenance.as_of).toBe("");
    expect(formatProvenance(provenance)).toBeNull();
  });
  it("keeps unbuilt feeds visibly marked", () => {
    expect(cardProvenance({ ...SEED_CARDS[0], feed: "edgar" }).feed).toBe("SEC EDGAR filings and fundamentals (not built)");
    expect(cardProvenance({ ...SEED_CARDS[0], feed: "alpaca_bars" }).feed).toBe("Alpaca daily bars");
  });
});
