/**
 * LIVE: the local portfolio-health path against the real Neon database.
 *
 * The incident this path exists for
 * (docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md)
 * set an explicit bar, and it is the reason this file exists at all:
 *
 *   "no step is treated as *fixed* until a positive observation against a
 *    running backend confirms it — code passing tsc/vitest is necessary, not
 *    sufficient."
 *
 * The pure tests in __tests__/portfolio-health-policy.test.ts score cards that
 * *we* wrote. They cannot prove the SQL reads the right columns, that
 * `ticker_cards.score` is really on the [-100, 100] scale the scorer assumes,
 * or that a real watchlist has enough coverage to produce anything. That is
 * what this asserts.
 *
 * Invariants only — never a specific score. The cards change nightly.
 */
import { describe, it, expect } from "vitest";
import { isPortfolioHealth } from "@/lib/portfolio";

const HAS_DB = (process.env.DATABASE_URL ?? "").length > 0;
const describeDb = HAS_DB ? describe : describe.skip;

/** Seeded by scripts/hydrate-dev.mjs + scripts/seed-watchlist-universe.mjs --dev. */
const DEV_USER_ID = "user_devlocal000000000000000";

describeDb("local portfolio health (live Neon)", () => {
  it("scores a real watchlist without touching gcp3", async () => {
    const { getWatchlist } = await import("@/lib/watchlist-store");
    const { localPortfolioHealth } = await import("@/lib/portfolio-health-local");

    const tickers = (await getWatchlist(DEV_USER_ID)).map((w) => w.ticker);
    if (tickers.length === 0) {
      // Not a failure — the dev user simply isn't seeded in this database.
      // "blocked is not fail" (docs/e2e.md §4).
      console.warn(`[live] ${DEV_USER_ID} has an empty watchlist — nothing to score.`);
      return;
    }

    const health = await localPortfolioHealth(tickers);
    expect(health, "a seeded watchlist must produce a score with no backend").not.toBeNull();

    // The exact contract the client validates before rendering. A shape the
    // client rejects is the "score 0 / Grade F" class of silent failure.
    expect(isPortfolioHealth(health)).toBe(true);

    expect(health!.score).toBeGreaterThanOrEqual(0);
    expect(health!.score).toBeLessThanOrEqual(100);
    expect(health!.factors.length).toBeGreaterThan(0);
    for (const f of health!.factors) {
      expect(f.score, f.name).toBeGreaterThanOrEqual(0);
      expect(f.score, f.name).toBeLessThanOrEqual(100);
    }

    // Coverage must be honest about the real watchlist, not silently reduced
    // to whatever happened to have a card.
    const coverage = health!.factors.find((f) => f.name === "Signal coverage");
    expect(coverage, "coverage factor must always be reported").toBeDefined();
    expect(coverage!.description).toContain(`of ${tickers.length}`);
  });

  it("returns null — not a fabricated score — for tickers with no cards", async () => {
    const { localPortfolioHealth } = await import("@/lib/portfolio-health-local");
    const health = await localPortfolioHealth(["ZZZZNOTAREALTICKER1", "ZZZZNOTAREALTICKER2"]);
    expect(health).toBeNull();
  });
});
