import { describe, it, expect } from "vitest";
import {
  buildLocalHealth,
  buildLocalSuggestions,
  type HealthCardInput,
} from "@/lib/portfolio-health-policy";

const card = (over: Partial<HealthCardInput> = {}): HealthCardInput => ({
  ticker: "AAPL",
  universe: "stock",
  score: 0,
  action: "HOLD",
  dataQuality: 1,
  ...over,
});

describe("buildLocalHealth", () => {
  it("returns null when nothing can be scored", () => {
    expect(buildLocalHealth([], [])).toBeNull();
    // The case the whole fallback exists for: a watchlist with tickers but no
    // computed cards has no score, and must not be handed a fabricated one.
    expect(buildLocalHealth(["AAPL", "MSFT"], [])).toBeNull();
  });

  it("produces a valid PortfolioHealth with a 0-100 score", () => {
    const health = buildLocalHealth(["AAPL"], [card()]);
    expect(health).not.toBeNull();
    expect(health!.score).toBeGreaterThanOrEqual(0);
    expect(health!.score).toBeLessThanOrEqual(100);
    expect(health!.grade).toMatch(/^[A-F]$/);
    expect(Date.parse(health!.generatedAt)).not.toBeNaN();
  });

  it("scores a strong, broad, all-BUY book above a weak, narrow, all-SELL one", () => {
    const strong = buildLocalHealth(
      Array.from({ length: 12 }, (_, i) => `T${i}`),
      Array.from({ length: 12 }, (_, i) =>
        card({ ticker: `T${i}`, score: 70, action: "BUY", universe: i < 4 ? "etf" : "stock" }),
      ),
    );
    const weak = buildLocalHealth(
      ["A", "B"],
      [card({ ticker: "A", score: -70, action: "SELL" }), card({ ticker: "B", score: -70, action: "SELL" })],
    );
    expect(strong!.score).toBeGreaterThan(weak!.score);
    expect(weak!.score).toBeLessThan(50);
  });

  it("weights low-quality cards down without dropping them", () => {
    const tickers = ["GOOD", "BAD"];
    const trusted = buildLocalHealth(tickers, [
      card({ ticker: "GOOD", score: 80, dataQuality: 1 }),
      card({ ticker: "BAD", score: -80, dataQuality: 1 }),
    ])!;
    const discounted = buildLocalHealth(tickers, [
      card({ ticker: "GOOD", score: 80, dataQuality: 1 }),
      card({ ticker: "BAD", score: -80, dataQuality: 0.1 }),
    ])!;
    // The bad card still counts (coverage is unchanged) but pulls less.
    expect(discounted.score).toBeGreaterThan(trusted.score);
    expect(discounted.factors.find(f => f.name === "Signal coverage")!.score).toBe(100);
  });

  it("reports partial coverage without letting it depress the score", () => {
    const cards = [card({ ticker: "AAPL", score: 60, action: "BUY" })];
    const full = buildLocalHealth(["AAPL"], cards)!;
    const partial = buildLocalHealth(["AAPL", "MSFT", "NVDA", "TSLA"], cards)!;
    const coverage = partial.factors.find(f => f.name === "Signal coverage")!;

    expect(coverage.score).toBe(25);
    expect(coverage.impact).toBe("neutral");
    expect(partial.summary).toContain("3 tickers have no computed signal");
    // Coverage is informational only — the two differ solely via breadth,
    // never because uncovered names were scored as though they were bad.
    expect(partial.score).toBeGreaterThanOrEqual(full.score);
  });

  it("keeps every factor inside 0-100", () => {
    const health = buildLocalHealth(
      Array.from({ length: 50 }, (_, i) => `T${i}`),
      Array.from({ length: 50 }, (_, i) => card({ ticker: `T${i}`, score: 100, action: "BUY" })),
    )!;
    for (const f of health.factors) {
      expect(f.score, f.name).toBeGreaterThanOrEqual(0);
      expect(f.score, f.name).toBeLessThanOrEqual(100);
    }
  });

  describe("freshness (docs/portfolio-health-todo.md §0)", () => {
    const now = new Date("2026-09-14T00:00:00Z");

    it("scores a fresh, dated book above an otherwise-identical stale one", () => {
      const fresh = buildLocalHealth(
        ["AAPL"],
        [card({ ticker: "AAPL", score: 40, barDate: "2026-09-13" })],
        now,
      )!;
      const stale = buildLocalHealth(
        ["AAPL"],
        [card({ ticker: "AAPL", score: 40, barDate: "2026-08-19" })],
        now,
      )!;
      expect(stale.score).toBeLessThan(fresh.score);
      const staleFreshnessFactor = stale.factors.find(f => f.name === "Signal freshness")!;
      const freshFreshnessFactor = fresh.factors.find(f => f.name === "Signal freshness")!;
      expect(staleFreshnessFactor.score).toBeLessThan(freshFreshnessFactor.score);
    });

    it("never drops a stale card — coverage is unaffected by staleness", () => {
      const health = buildLocalHealth(
        ["AAPL", "MSFT"],
        [
          card({ ticker: "AAPL", barDate: "2026-09-13" }),
          card({ ticker: "MSFT", barDate: "2026-06-01" }), // ~3 months stale
        ],
        now,
      )!;
      expect(health.factors.find(f => f.name === "Signal coverage")!.score).toBe(100);
    });

    it("floors rather than zeroes an extremely stale card's weight", () => {
      const health = buildLocalHealth(
        ["AAPL"],
        [card({ ticker: "AAPL", score: 80, barDate: "2020-01-01" })],
        now,
      )!;
      // Still produces a real, non-degenerate score — the card contributes a
      // small but nonzero weight, it is never treated as absent.
      expect(health.score).toBeGreaterThan(0);
      expect(health.factors.find(f => f.name === "Signal freshness")!.score).toBeGreaterThanOrEqual(0);
    });

    it("reports 'unavailable' freshness, not a false positive, when no card has a bar date", () => {
      const health = buildLocalHealth(["AAPL"], [card({ ticker: "AAPL" })], now)!;
      const freshness = health.factors.find(f => f.name === "Signal freshness")!;
      expect(freshness.description).toContain("unavailable");
    });

    it("excludes freshness from the weighted score (not scored as 100) when no card has a bar date", () => {
      // Undated freshness still renders as `score: 100` in the *displayed*
      // factor (the previous test), but must not feed the headline score —
      // that would credit the portfolio for freshness data it doesn't have.
      const cards = [card({ ticker: "AAPL", score: 40 }), card({ ticker: "MSFT", score: -20, action: "SELL" })];
      const health = buildLocalHealth(["AAPL", "MSFT"], cards, now)!;
      const signal = health.factors.find(f => f.name === "Signal strength")!;
      const direction = health.factors.find(f => f.name === "Directional risk")!;
      const diversification = health.factors.find(f => f.name === "Diversification")!;
      const freshness = health.factors.find(f => f.name === "Signal freshness")!;

      // The displayed freshness factor is still the neutral 100 the previous
      // test asserts on — confirming this test's premise hasn't drifted.
      expect(freshness.score).toBe(100);

      // Renormalized: the three available factors' weights (0.36/0.24/0.20)
      // divided by (1 - 0.20) restore their pre-freshness 0.45/0.30/0.25
      // balance, per WEIGHTS's own doc comment.
      const expected = Math.round(
        (signal.score * 0.36 + direction.score * 0.24 + diversification.score * 0.2) / 0.8,
      );
      expect(health.score).toBe(expected);

      // The bug this guards: naively weighting freshness.score (100) in at
      // 0.20 would produce a different, inflated number.
      const inflated = Math.round(
        signal.score * 0.36 + direction.score * 0.24 + diversification.score * 0.2 + 100 * 0.2,
      );
      expect(health.score).not.toBe(inflated);
    });

    it("summarizes the bar-date distribution instead of a single latest date", () => {
      const health = buildLocalHealth(
        ["A", "B", "C"],
        [
          card({ ticker: "A", barDate: "2026-09-13" }),
          card({ ticker: "B", barDate: "2026-08-19" }),
          card({ ticker: "C", barDate: "2026-08-19" }),
        ],
        now,
      )!;
      expect(health.summary).toContain("2 from 2026-08-19");
      expect(health.summary).toContain("1 from 2026-09-13");
    });
  });
});

describe("buildLocalSuggestions", () => {
  it("returns nothing actionable for an all-neutral, broad book", () => {
    const cards = Array.from({ length: 10 }, (_, i) => card({ ticker: `T${i}`, score: 0 }));
    expect(buildLocalSuggestions(cards, 10)).toEqual([]);
  });

  it("surfaces the worst SELLs first, as high priority", () => {
    const out = buildLocalSuggestions(
      [
        card({ ticker: "OK", score: 5 }),
        card({ ticker: "BAD", score: -50, action: "SELL" }),
        card({ ticker: "WORSE", score: -90, action: "SELL" }),
      ],
      3,
    );
    expect(out[0].ticker).toBe("WORSE");
    expect(out[0].priority).toBe("high");
    expect(out.every(s => s.disclaimer.length > 0)).toBe(true);
  });

  it("nudges on breadth only for a thin watchlist", () => {
    const thin = buildLocalSuggestions([card({ ticker: "AAPL" })], 1);
    expect(thin.some(s => s.id === "local-breadth")).toBe(true);
    const broad = buildLocalSuggestions([card({ ticker: "AAPL" })], 20);
    expect(broad.some(s => s.id === "local-breadth")).toBe(false);
  });

  it("caps the list", () => {
    const cards = Array.from({ length: 40 }, (_, i) =>
      card({ ticker: `S${i}`, score: -60, action: "SELL" }),
    );
    expect(buildLocalSuggestions(cards, 40).length).toBeLessThanOrEqual(6);
  });
});
