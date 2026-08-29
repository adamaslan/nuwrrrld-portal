import { describe, it, expect } from "vitest";
import {
  deriveSegments,
  assertNoFinancialFields,
  FIELD_CLASS,
  FINANCIAL_FIELDS,
  SEGMENT_RULES,
} from "@/lib/customer-profile-rules";

const base = {
  councilSessions: 0,
  nuaiDaysActive: 0,
  watchlistSize: 0,
  daysSinceLastActivity: null as number | null,
  isTrial: false,
};

describe("deriveSegments", () => {
  it("assigns nothing for a brand-new user", () => {
    expect(deriveSegments(base).segments).toEqual([]);
  });

  it("power_user needs both sessions and a real watchlist", () => {
    expect(deriveSegments({ ...base, councilSessions: 5, watchlistSize: 2 }).segments).not.toContain(
      "power_user",
    );
    expect(deriveSegments({ ...base, councilSessions: 5, watchlistSize: 3 }).segments).toContain(
      "power_user",
    );
  });

  it("at_risk_churn only past 30 days", () => {
    expect(deriveSegments({ ...base, daysSinceLastActivity: 30 }).segments).not.toContain(
      "at_risk_churn",
    );
    expect(deriveSegments({ ...base, daysSinceLastActivity: 31 }).segments).toContain(
      "at_risk_churn",
    );
  });

  it("trial_stalled requires a trial with zero sessions", () => {
    expect(deriveSegments({ ...base, isTrial: true }).segments).toContain("trial_stalled");
    expect(
      deriveSegments({ ...base, isTrial: true, councilSessions: 1 }).segments,
    ).not.toContain("trial_stalled");
  });

  it("signal_only means a watchlist but no council use", () => {
    expect(deriveSegments({ ...base, watchlistSize: 1 }).segments).toContain("signal_only");
    expect(
      deriveSegments({ ...base, watchlistSize: 1, councilSessions: 1 }).segments,
    ).not.toContain("signal_only");
  });

  it("ai_heavy triggers on either council volume or nuai days", () => {
    expect(deriveSegments({ ...base, councilSessions: 10 }).segments).toContain("ai_heavy");
    expect(deriveSegments({ ...base, nuaiDaysActive: 5 }).segments).toContain("ai_heavy");
  });

  it("every assigned segment carries its derivation (GDPR Art. 15)", () => {
    const { segments, derivations } = deriveSegments({
      ...base,
      councilSessions: 12,
      watchlistSize: 4,
    });
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      expect(derivations[s]).toBe(SEGMENT_RULES[s]);
      expect(typeof derivations[s]).toBe("string");
    }
  });
});

describe("financial-field guard", () => {
  it("throws on any field classified financial", () => {
    for (const f of FINANCIAL_FIELDS) {
      expect(() => assertNoFinancialFields({ [f]: 1 })).toThrow(/financial field/);
    }
  });

  it("allows a clean payload", () => {
    expect(() =>
      assertNoFinancialFields({ user_id: "u1", segments: [], interest_tags: ["NVDA"] }),
    ).not.toThrow();
  });

  it("classifies holdings/position_sizes/portfolio_value as financial", () => {
    expect(FIELD_CLASS.holdings).toBe("financial");
    expect(FIELD_CLASS.position_sizes).toBe("financial");
    expect(FIELD_CLASS.portfolio_value).toBe("financial");
  });

  it("does not derive any special-category-adjacent inference (plan 5.2)", () => {
    const forbidden = ["net_worth", "income", "creditworthiness", "employment", "distress"];
    for (const seg of Object.keys(SEGMENT_RULES)) {
      for (const f of forbidden) expect(seg).not.toContain(f);
    }
  });
});
