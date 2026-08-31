/**
 * followed-tickers-policy — unit tests for cohort selection + horizon-due logic.
 * Pure module; no DATABASE_URL.
 */
import { describe, expect, it } from "vitest";
import {
  cohortMonthOf,
  dueHorizons,
  pickDirection,
  selectCohort,
  tradingDaysBetween,
  ytdIsFinal,
  type RankableCard,
} from "@/lib/shared/followed-tickers-policy";

describe("pickDirection", () => {
  it("maps bull/bear labels regardless of exact wording", () => {
    expect(pickDirection("bullish")).toBe("bull");
    expect(pickDirection("BULL")).toBe("bull");
    expect(pickDirection("bearish")).toBe("bear");
  });
  it("treats neutral / unknown as no directional signal", () => {
    expect(pickDirection("neutral")).toBeNull();
    expect(pickDirection("")).toBeNull();
    expect(pickDirection("sideways")).toBeNull();
  });
});

describe("selectCohort", () => {
  const card = (ticker: string, direction: string, score: number, barsScanned?: number): RankableCard => ({
    ticker,
    direction,
    score,
    barsScanned,
  });

  it("takes the strongest N per side by |score|; bears are the most negative", () => {
    const cards = [
      card("AAA", "bullish", 90),
      card("BBB", "bullish", 80),
      card("CCC", "bullish", 10),
      card("DDD", "bearish", -95),
      card("EEE", "bearish", -70),
      card("FFF", "bearish", -5),
      card("GGG", "neutral", 0),
    ];
    const { bulls, bears } = selectCohort(cards, 2);
    expect(bulls.map((p) => p.ticker)).toEqual(["AAA", "BBB"]);
    expect(bears.map((p) => p.ticker)).toEqual(["DDD", "EEE"]);
    expect(bears[0].strength).toBe(95); // abs(score)
  });

  it("breaks ties by bars_scanned (more history first), then alphabetically", () => {
    const cards = [
      card("ZZZ", "bullish", 50, 100),
      card("AAA", "bullish", 50, 100),
      card("MMM", "bullish", 50, 300),
    ];
    const { bulls } = selectCohort(cards, 3);
    expect(bulls.map((p) => p.ticker)).toEqual(["MMM", "AAA", "ZZZ"]);
  });

  it("ignores neutral / absent-signal cards entirely", () => {
    const cards = [card("AAA", "neutral", 0), card("BBB", "bullish", 40)];
    const { bulls, bears } = selectCohort(cards, 5);
    expect(bulls.map((p) => p.ticker)).toEqual(["BBB"]);
    expect(bears).toHaveLength(0);
  });

  it("returns fewer than N when a side is short", () => {
    const cards = [card("AAA", "bullish", 40)];
    expect(selectCohort(cards, 10).bulls).toHaveLength(1);
  });

  it("is deterministic — same ranking in, same cohort out", () => {
    const cards = [
      card("AAA", "bullish", 30),
      card("BBB", "bullish", 30),
      card("CCC", "bearish", -30),
    ];
    expect(JSON.stringify(selectCohort(cards, 2))).toEqual(JSON.stringify(selectCohort(cards, 2)));
  });

  /**
   * Regression guard for the ranking bug this module cannot fix on its own.
   *
   * `selectCohort` splits whatever it is handed; it has no say in how those
   * cards were fetched. When the caller fetched them with a single signed
   * `ORDER BY score DESC ... LIMIT n` — as followed-tickers-select did with
   * LIMIT 200 — the rows it receives at universe scale are all bulls, and the
   * bear side silently comes up short. This asserts that failure mode
   * explicitly so the route's use of `bipolarCards` (both tails) is understood
   * as load-bearing rather than an interchangeable refactor.
   */
  it("cannot fill the bear side when handed a signed-DESC cut of a large universe", () => {
    // 950 tickers ranked by signed score; a `LIMIT 200` off `score DESC` takes
    // the 200 most bullish, which at this scale never reaches below zero.
    const universe: RankableCard[] = Array.from({ length: 950 }, (_, i) => ({
      ticker: `T${String(i).padStart(4, "0")}`,
      // Scores descend from +95 to -95 across the universe.
      score: 95 - (i * 190) / 949,
      direction: 95 - (i * 190) / 949 >= 0 ? "bullish" : "bearish",
    }));

    const signedCut = universe.slice(0, 200); // what `topCards(h, 200)` returns
    const fromCut = selectCohort(signedCut, 10);
    expect(fromCut.bulls).toHaveLength(10);
    expect(fromCut.bears).toHaveLength(0); // the bug: no bears survive the cut

    // Taking from both tails — what `bipolarCards` does — fills both sides.
    const bothTails = [...universe.slice(0, 200), ...universe.slice(-200)];
    const fromTails = selectCohort(bothTails, 10);
    expect(fromTails.bulls).toHaveLength(10);
    expect(fromTails.bears).toHaveLength(10);
    // And the bears chosen are genuinely the strongest negatives, not stragglers.
    for (const bear of fromTails.bears) expect(bear.strength).toBeGreaterThan(90);
  });

});

describe("cohortMonthOf", () => {
  it("is the first of the UTC month", () => {
    expect(cohortMonthOf(new Date("2026-08-30T18:00:00Z"))).toBe("2026-08-01");
    expect(cohortMonthOf(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12-01");
  });
});

describe("dueHorizons", () => {
  it("returns every fixed-offset horizon whose trading-day count has elapsed", () => {
    expect(dueHorizons(0)).toEqual([]);
    expect(dueHorizons(1)).toEqual(["d1"]);
    expect(dueHorizons(5)).toEqual(["d1", "w1"]);
    expect(dueHorizons(21)).toEqual(["d1", "w1", "m1"]);
    expect(dueHorizons(300)).toEqual(["d1", "w1", "m1", "m3", "m6", "y1"]);
  });
  it("never includes ytd — that is calendar-anchored and resolved separately", () => {
    expect(dueHorizons(300)).not.toContain("ytd");
  });
});

describe("ytdIsFinal", () => {
  it("false before Dec 31 of the entry year", () => {
    expect(ytdIsFinal(new Date("2026-03-01T00:00:00Z"), new Date("2026-11-15T00:00:00Z"))).toBe(false);
  });
  it("true on/after Dec 31 of the entry year", () => {
    expect(ytdIsFinal(new Date("2026-03-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"))).toBe(true);
    expect(ytdIsFinal(new Date("2026-03-01T00:00:00Z"), new Date("2027-01-02T00:00:00Z"))).toBe(true);
  });
});

describe("tradingDaysBetween", () => {
  it("counts weekdays exclusive of the start, inclusive of steps toward end", () => {
    // Mon 2026-08-03 → Mon 2026-08-10 is 5 weekdays.
    expect(tradingDaysBetween(new Date("2026-08-03"), new Date("2026-08-10"))).toBe(5);
  });
  it("is zero when end is not after start", () => {
    expect(tradingDaysBetween(new Date("2026-08-10"), new Date("2026-08-10"))).toBe(0);
    expect(tradingDaysBetween(new Date("2026-08-10"), new Date("2026-08-03"))).toBe(0);
  });
  it("skips the weekend", () => {
    // Fri 2026-08-07 → Mon 2026-08-10 is 1 trading day.
    expect(tradingDaysBetween(new Date("2026-08-07"), new Date("2026-08-10"))).toBe(1);
  });
});
