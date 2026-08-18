/**
 * card-policy — unit tests for the zero-AI-cost coverage layer.
 *
 * These run without DATABASE_URL by design: card-policy.ts is pure, which is
 * the whole reason it is split from ticker-cards-db.ts. If a test here needs a
 * database, the function under test is in the wrong module.
 */
import { describe, expect, it } from "vitest";
import {
  CARD_INPUT_FIELDS,
  CARD_SCORE_VERSION,
  MIN_EXPLAIN_QUALITY,
  actionFromScore,
  buildCard,
  dataQuality,
  explainCallCount,
  isExplainable,
  missingInputFields,
  scoreCard,
  shouldReplaceCard,
} from "@/lib/shared/card-policy";
import { TAXONOMY_VERSION, type SignalStateInput, type StateKeyParts } from "@/lib/grounding/taxonomy";

const FULL: SignalStateInput = {
  rsi: 58,
  macdCross: "bullish",
  adx: 27,
  volatilityPercentile: 61,
  confluenceScore: 72,
  direction: "bullish",
};

function parts(over: Partial<StateKeyParts> = {}): StateKeyParts {
  return {
    rsi: "neutral",
    macd: "none",
    adx: "ranging",
    vol: "normal",
    confluence: "weak",
    direction: "neutral",
    horizon: "t1",
    ...over,
  };
}

describe("data quality and missing fields", () => {
  it("reports full quality when every input is present", () => {
    expect(dataQuality(FULL)).toBe(1);
    expect(missingInputFields(FULL)).toEqual([]);
  });

  it("counts each absent input against quality", () => {
    const partial: SignalStateInput = { rsi: 58, macdCross: "bullish", direction: "bullish" };
    expect(missingInputFields(partial)).toEqual(["adx", "volatilityPercentile", "confluenceScore"]);
    expect(dataQuality(partial)).toBeCloseTo(2 / 5);
  });

  it("treats an entirely empty input as zero quality, not as an error", () => {
    expect(dataQuality({})).toBe(0);
    expect(missingInputFields({})).toEqual([...CARD_INPUT_FIELDS]);
  });

  it("treats an explicit MACD null as measured, and an omitted key as missing", () => {
    // MACD is the one field with a legitimate third state: `null` means
    // "computed, no cross occurred" (an observation), while an omitted key
    // means "never computed" (a gap). The four numeric fields have no such
    // distinction — for them, null is always absence.
    expect(missingInputFields({ ...FULL, macdCross: null })).toEqual([]);
    expect(missingInputFields({ ...FULL, macdCross: undefined })).toEqual(["macdCross"]);
  });

  it("distinguishes a genuinely neutral market from missing inputs", () => {
    // The core hazard: toStateKeyParts() defaults absent values into
    // neutral-looking buckets, so these two produce the SAME tokens. Only
    // missing_fields tells them apart — if this ever stops holding, a failed
    // fetch starts rendering as a confident neutral card.
    const measured: SignalStateInput = {
      rsi: 50, macdCross: null, adx: 10, volatilityPercentile: 50,
      confluenceScore: 10, direction: "neutral",
    };
    const absent: SignalStateInput = { direction: "neutral" };

    const a = buildCard("AAA", "stock", measured, "t1");
    const b = buildCard("BBB", "stock", absent, "t1");

    expect(a.tokens).toEqual(b.tokens);
    expect(a.stateKey).toBe(b.stateKey);
    expect(a.missingFields).toEqual([]);
    expect(b.missingFields.length).toBeGreaterThan(0);
    expect(isExplainable(a)).toBe(true);
    expect(isExplainable(b)).toBe(false);
  });
});

describe("scoring", () => {
  it("is deterministic for the same tokens", () => {
    const p = parts({ confluence: "strong", direction: "bullish", macd: "bullish_cross" });
    expect(scoreCard(p)).toBe(scoreCard(p));
  });

  it("signs the confluence weight by direction", () => {
    const bull = scoreCard(parts({ confluence: "strong", direction: "bullish" }));
    const bear = scoreCard(parts({ confluence: "strong", direction: "bearish" }));
    expect(bull).toBeGreaterThan(0);
    expect(bear).toBeLessThan(0);
    expect(bull).toBe(-bear);
  });

  it("scores a neutral direction at zero confluence contribution", () => {
    expect(scoreCard(parts({ confluence: "strong", direction: "neutral" }))).toBe(0);
  });

  it("lets a MACD cross disagree with the verdict direction", () => {
    // Deliberate: a bullish cross under a bearish verdict is real tension and
    // should pull the score toward neutral rather than being suppressed.
    const withCross = scoreCard(parts({ confluence: "moderate", direction: "bearish", macd: "bullish_cross" }));
    const without = scoreCard(parts({ confluence: "moderate", direction: "bearish", macd: "none" }));
    expect(withCross).toBeGreaterThan(without);
  });

  it("treats oversold as opportunity and overbought as caution", () => {
    const base = parts({ confluence: "moderate", direction: "bullish" });
    expect(scoreCard({ ...base, rsi: "oversold" })).toBeGreaterThan(scoreCard(base));
    expect(scoreCard({ ...base, rsi: "overbought" })).toBeLessThan(scoreCard(base));
  });

  it("amplifies conviction when trending and damps it when volatile", () => {
    const base = parts({ confluence: "strong", direction: "bullish" });
    expect(scoreCard({ ...base, adx: "trending" })).toBeGreaterThan(scoreCard(base));
    expect(scoreCard({ ...base, vol: "high" })).toBeLessThan(scoreCard(base));
  });

  it("stays within [-100, 100] at every reachable extreme", () => {
    const dims = {
      rsi: ["oversold", "neutral", "overbought"],
      macd: ["bullish_cross", "bearish_cross", "none"],
      adx: ["trending", "ranging"],
      vol: ["low", "normal", "high"],
      confluence: ["weak", "moderate", "strong"],
      direction: ["bullish", "bearish", "neutral"],
      horizon: ["t1", "t2"],
    } as const;

    let count = 0;
    for (const rsi of dims.rsi)
      for (const macd of dims.macd)
        for (const adx of dims.adx)
          for (const vol of dims.vol)
            for (const confluence of dims.confluence)
              for (const direction of dims.direction)
                for (const horizon of dims.horizon) {
                  const score = scoreCard({ rsi, macd, adx, vol, confluence, direction, horizon });
                  expect(score).toBeGreaterThanOrEqual(-100);
                  expect(score).toBeLessThanOrEqual(100);
                  expect(Number.isInteger(score)).toBe(true);
                  count += 1;
                }

    // The full reachable state space: 3×3×2×3×3×3×2. Asserted so a new bucket
    // value in the taxonomy fails here loudly rather than silently widening the
    // space the compiled grounding pack is indexed against.
    expect(count).toBe(972);
  });
});

describe("action boundaries", () => {
  it("maps scores to actions with a wide neutral band", () => {
    expect(actionFromScore(35)).toBe("BUY");
    expect(actionFromScore(34)).toBe("HOLD");
    expect(actionFromScore(0)).toBe("HOLD");
    expect(actionFromScore(-34)).toBe("HOLD");
    expect(actionFromScore(-35)).toBe("SELL");
  });

  it("never emits BUY or SELL for an inputless card", () => {
    expect(buildCard("XXX", "stock", {}, "t1").action).toBe("HOLD");
  });
});

describe("buildCard", () => {
  it("stamps both versions onto every card", () => {
    const card = buildCard("AAPL", "stock", FULL, "t1");
    expect(card.taxonomyVersion).toBe(TAXONOMY_VERSION);
    expect(card.scoreVersion).toBe(CARD_SCORE_VERSION);
  });

  it("produces a state key that matches the taxonomy's format", () => {
    const card = buildCard("AAPL", "stock", FULL, "t1");
    expect(card.stateKey).toBe(
      "rsi:neutral|macd:bullish_cross|adx:trending|vol:normal|confluence:strong|dir:bullish|h:t1",
    );
  });

  it("gives the two horizons distinct keys for the same input", () => {
    const t1 = buildCard("AAPL", "stock", FULL, "t1");
    const t2 = buildCard("AAPL", "stock", FULL, "t2");
    expect(t1.stateKey).not.toBe(t2.stateKey);
    expect(t1.score).toBe(t2.score); // horizon labels the state; it doesn't score
  });

  it("carries the universe through so the two lanes never blur", () => {
    expect(buildCard("XLK", "etf", FULL, "t1").universe).toBe("etf");
    expect(buildCard("AAPL", "stock", FULL, "t1").universe).toBe("stock");
  });
});

describe("explain gating", () => {
  it("admits a complete card and refuses an incomplete one", () => {
    expect(isExplainable(buildCard("A", "stock", FULL, "t1"))).toBe(true);
    expect(isExplainable(buildCard("B", "stock", { rsi: 50 }, "t1"))).toBe(false);
  });

  it("refuses a card that clears the quality bar but is still missing a field", () => {
    // 4 of 5 present = 0.8, exactly MIN_EXPLAIN_QUALITY. The ratio gate passes;
    // the emptiness gate must still refuse it. Both gates exist because they
    // answer different questions.
    const card = buildCard("C", "stock", { ...FULL, confluenceScore: null }, "t1");
    expect(card.dataQuality).toBeCloseTo(MIN_EXPLAIN_QUALITY);
    expect(isExplainable(card)).toBe(false);
  });
});

describe("replacement rule", () => {
  const stored = { barDate: "2026-08-18", dataQuality: 1 };

  it("writes when nothing is stored", () => {
    expect(shouldReplaceCard({ barDate: "2026-08-18", dataQuality: 0 }, null)).toBe(true);
  });

  it("accepts a newer bar even at lower quality", () => {
    expect(shouldReplaceCard({ barDate: "2026-08-19", dataQuality: 0.2 }, stored)).toBe(true);
  });

  it("refuses an older bar even at perfect quality", () => {
    expect(shouldReplaceCard({ barDate: "2026-08-17", dataQuality: 1 }, stored)).toBe(false);
  });

  it("refuses to downgrade a same-day card with worse data", () => {
    // The rule that keeps a bad vendor night from erasing a good one.
    expect(shouldReplaceCard({ barDate: "2026-08-18", dataQuality: 0.4 }, stored)).toBe(false);
  });

  it("upgrades a same-day card when the new data is better", () => {
    const partial = { barDate: "2026-08-18", dataQuality: 0.6 };
    expect(shouldReplaceCard({ barDate: "2026-08-18", dataQuality: 1 }, partial)).toBe(true);
  });

  it("refuses an identical re-post, so a retried batch is a no-op", () => {
    expect(shouldReplaceCard({ barDate: "2026-08-18", dataQuality: 1 }, stored)).toBe(false);
  });
});

describe("explain cost ceiling", () => {
  it("is knowable before the job runs", () => {
    expect(explainCallCount(100, 10)).toBe(10);
    expect(explainCallCount(95, 10)).toBe(10);
    expect(explainCallCount(101, 10)).toBe(11);
  });

  it("costs nothing for an empty ranking", () => {
    expect(explainCallCount(0, 10)).toBe(0);
  });

  it("refuses to divide by a zero batch size", () => {
    expect(explainCallCount(100, 0)).toBe(0);
  });
});
