/**
 * universe-policy — unit tests for the ranked-universe read decisions.
 *
 * These run without DATABASE_URL by design: universe-policy.ts is pure, which
 * is the whole reason it is split from ticker-cards-db.ts. If a test here needs
 * a database, the function under test is in the wrong module.
 */
import { describe, expect, it } from "vitest";
import type { CardAction, CardUniverse } from "@/lib/shared/card-policy";
import {
  DEFAULT_TOP_LIMIT,
  MAX_TOP_LIMIT,
  STRONG_SCORE,
  cardAgeDays,
  isStrongCard,
  resolveHorizon,
  resolveLimit,
  resolveUniverseScope,
  summarizeRanking,
} from "@/lib/shared/universe-policy";

describe("resolveUniverseScope", () => {
  it("passes through the three valid scopes", () => {
    expect(resolveUniverseScope("stock")).toBe("stock");
    expect(resolveUniverseScope("etf")).toBe("etf");
    expect(resolveUniverseScope("all")).toBe("all");
  });

  // The important half. A ranked read that silently widens to 'all' puts
  // inverse and leveraged funds back beside equities — the exact defect the
  // scope argument exists to prevent — so every unrecognized input must
  // narrow to 'stock', never widen.
  it.each([
    ["stocks", "a plausible typo"],
    ["ETF", "wrong case"],
    ["", "empty string"],
    [null, "absent param"],
    [undefined, "missing key"],
    ["everything", "made-up value"],
    [42, "non-string"],
  ])("collapses %o (%s) to 'stock', never 'all'", (input, _why) => {
    expect(resolveUniverseScope(input)).toBe("stock");
  });
});

describe("resolveHorizon", () => {
  it("accepts t2 and defaults everything else to t1", () => {
    expect(resolveHorizon("t2")).toBe("t2");
    expect(resolveHorizon("t1")).toBe("t1");
    expect(resolveHorizon("t3")).toBe("t1");
    expect(resolveHorizon(null)).toBe("t1");
  });
});

describe("resolveLimit", () => {
  it("uses the default when absent or unparseable", () => {
    expect(resolveLimit(null)).toBe(DEFAULT_TOP_LIMIT);
    expect(resolveLimit("")).toBe(DEFAULT_TOP_LIMIT);
    expect(resolveLimit("abc")).toBe(DEFAULT_TOP_LIMIT);
    expect(resolveLimit(Number.NaN)).toBe(DEFAULT_TOP_LIMIT);
  });

  it("accepts an in-range value and truncates fractions", () => {
    expect(resolveLimit("10")).toBe(10);
    expect(resolveLimit(10)).toBe(10);
    expect(resolveLimit(10.9)).toBe(10);
  });

  it("clamps above the cap and rejects non-positive values", () => {
    expect(resolveLimit(MAX_TOP_LIMIT + 1)).toBe(MAX_TOP_LIMIT);
    expect(resolveLimit(10_000)).toBe(MAX_TOP_LIMIT);
    expect(resolveLimit(0)).toBe(DEFAULT_TOP_LIMIT);
    expect(resolveLimit(-5)).toBe(DEFAULT_TOP_LIMIT);
  });
});

describe("isStrongCard", () => {
  it("counts a high score as strong regardless of action", () => {
    expect(isStrongCard(STRONG_SCORE, "HOLD")).toBe(true);
    expect(isStrongCard(STRONG_SCORE - 1, "HOLD")).toBe(false);
  });

  it("counts a directional action as strong regardless of score", () => {
    expect(isStrongCard(0, "BUY")).toBe(true);
    expect(isStrongCard(-99, "SELL")).toBe(true);
    expect(isStrongCard(0, "HOLD")).toBe(false);
  });
});

describe("cardAgeDays", () => {
  const now = new Date("2026-08-19T12:00:00Z");

  it("counts whole days from the bar date", () => {
    expect(cardAgeDays("2026-08-19", now)).toBe(0);
    expect(cardAgeDays("2026-08-18", now)).toBe(1);
    expect(cardAgeDays("2026-08-12", now)).toBe(7);
  });

  it("ignores the time of day on both sides", () => {
    // A card written at 23:59 UTC and read at 00:01 UTC the same calendar day
    // is zero days old, not one — the comparison is date-to-date.
    expect(cardAgeDays("2026-08-19", new Date("2026-08-19T00:01:00Z"))).toBe(0);
  });

  it("floors a future bar date at zero rather than going negative", () => {
    expect(cardAgeDays("2026-08-20", now)).toBe(0);
  });

  it("returns null for an unparseable date", () => {
    expect(cardAgeDays("not-a-date", now)).toBeNull();
  });

  // Regression: rowToStored built barDate with `String(row.bar_date).slice(0, 10)`,
  // and the Postgres driver returns a Date for `date` columns — so a bar dated
  // 2026-08-19 became the locale string "Tue Aug 18" (wrong day west of UTC,
  // and unparseable). That reached this function as a null age, which is how
  // the bug surfaced. Both the correct string form and a raw Date must work.
  it("handles the driver's Date object as well as an ISO string", () => {
    expect(cardAgeDays(new Date("2026-08-18T00:00:00Z"), now)).toBe(1);
    expect(cardAgeDays("2026-08-18", now)).toBe(1);
  });

  it("returns null for the locale-string shape the old code produced", () => {
    expect(cardAgeDays("Tue Aug 18", now)).toBeNull();
  });
});

describe("summarizeRanking", () => {
  const card = (score: number, action: CardAction, universe: CardUniverse = "stock") => ({
    score,
    action,
    universe,
  });

  it("reports zeroes and a null top score for an empty page", () => {
    expect(summarizeRanking([])).toEqual({ total: 0, strong: 0, etfCount: 0, topScore: null });
  });

  it("counts totals, strong cards, and the top score", () => {
    const out = summarizeRanking([
      card(80, "BUY"),
      card(10, "HOLD"),
      card(-50, "SELL"),
    ]);
    expect(out).toEqual({ total: 3, strong: 2, etfCount: 0, topScore: 80 });
  });

  // etfCount is the regression canary: a 'stock'-scoped read returning a
  // non-zero count means the card/universe label drift is back.
  it("surfaces ETF contamination in a supposedly stock-only page", () => {
    const out = summarizeRanking([card(50, "BUY"), card(46, "BUY", "etf")]);
    expect(out.etfCount).toBe(1);
  });

  it("takes the max score, not the first", () => {
    expect(summarizeRanking([card(10, "HOLD"), card(90, "BUY")]).topScore).toBe(90);
    expect(summarizeRanking([card(-10, "HOLD"), card(-90, "SELL")]).topScore).toBe(-10);
  });
});
