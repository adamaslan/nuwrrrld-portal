import { describe, it, expect } from "vitest";
import {
  buildLocalHealth,
  buildLocalSuggestions,
  type HealthCardInput,
} from "@/lib/shared/portfolio-health-policy";

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
