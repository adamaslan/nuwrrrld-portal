import { describe, expect, it } from "vitest";
import { toStateKey, toStateKeyParts } from "@/lib/grounding/taxonomy";

// Bucket-boundary regression tests for the signal-state taxonomy PR 1
// established (lib/grounding/taxonomy.ts). toStateKey() is the exact key
// grounding_pack.state_key is compiled against — a boundary shifting here
// silently invalidates every existing pack row without bumping
// TAXONOMY_VERSION, so these boundaries are pinned as tests, not just comments.

describe("toStateKeyParts — RSI bucket", () => {
  it("30 is the oversold boundary (inclusive)", () => {
    expect(toStateKeyParts({ rsi: 30 }, "t1").rsi).toBe("oversold");
    expect(toStateKeyParts({ rsi: 31 }, "t1").rsi).toBe("neutral");
  });
  it("70 is the overbought boundary (inclusive)", () => {
    expect(toStateKeyParts({ rsi: 70 }, "t1").rsi).toBe("overbought");
    expect(toStateKeyParts({ rsi: 69 }, "t1").rsi).toBe("neutral");
  });
  it("missing RSI defaults to neutral", () => {
    expect(toStateKeyParts({}, "t1").rsi).toBe("neutral");
    expect(toStateKeyParts({ rsi: null }, "t1").rsi).toBe("neutral");
  });
});

describe("toStateKeyParts — ADX bucket", () => {
  it("25 is the trending boundary (inclusive)", () => {
    expect(toStateKeyParts({ adx: 25 }, "t1").adx).toBe("trending");
    expect(toStateKeyParts({ adx: 24 }, "t1").adx).toBe("ranging");
  });
  it("missing ADX defaults to ranging", () => {
    expect(toStateKeyParts({}, "t1").adx).toBe("ranging");
  });
});

describe("toStateKeyParts — volatility bucket", () => {
  it("33 is the low boundary (inclusive)", () => {
    expect(toStateKeyParts({ volatilityPercentile: 33 }, "t1").vol).toBe("low");
    expect(toStateKeyParts({ volatilityPercentile: 34 }, "t1").vol).toBe("normal");
  });
  it("67 is the high boundary (inclusive)", () => {
    expect(toStateKeyParts({ volatilityPercentile: 67 }, "t1").vol).toBe("high");
    expect(toStateKeyParts({ volatilityPercentile: 66 }, "t1").vol).toBe("normal");
  });
  it("missing volatility defaults to normal", () => {
    expect(toStateKeyParts({}, "t1").vol).toBe("normal");
  });
});

describe("toStateKeyParts — confluence bucket", () => {
  it("34 is the moderate boundary (inclusive), 67 the strong boundary", () => {
    expect(toStateKeyParts({ confluenceScore: 33 }, "t1").confluence).toBe("weak");
    expect(toStateKeyParts({ confluenceScore: 34 }, "t1").confluence).toBe("moderate");
    expect(toStateKeyParts({ confluenceScore: 66 }, "t1").confluence).toBe("moderate");
    expect(toStateKeyParts({ confluenceScore: 67 }, "t1").confluence).toBe("strong");
  });
  it("uses the absolute value (a strongly bearish score is still 'strong')", () => {
    expect(toStateKeyParts({ confluenceScore: -80 }, "t1").confluence).toBe("strong");
  });
});

describe("toStateKeyParts — MACD + direction + horizon", () => {
  it("maps bullish/bearish cross, defaults to none", () => {
    expect(toStateKeyParts({ macdCross: "bullish" }, "t1").macd).toBe("bullish_cross");
    expect(toStateKeyParts({ macdCross: "bearish" }, "t1").macd).toBe("bearish_cross");
    expect(toStateKeyParts({}, "t1").macd).toBe("none");
  });
  it("defaults direction to neutral and passes horizon through", () => {
    const parts = toStateKeyParts({}, "t2");
    expect(parts.direction).toBe("neutral");
    expect(parts.horizon).toBe("t2");
  });
});

describe("toStateKey — determinism", () => {
  it("is a pure function: identical input always produces an identical key", () => {
    const input = { rsi: 28.4, macdCross: "bullish" as const, adx: 30, volatilityPercentile: 50, confluenceScore: 72, direction: "bullish" as const };
    expect(toStateKey(input, "t1")).toBe(toStateKey(input, "t1"));
  });
  it("differs when a bucketed dimension differs", () => {
    const base = { rsi: 28.4 };
    expect(toStateKey(base, "t1")).not.toBe(toStateKey({ rsi: 75 }, "t1"));
  });
});
