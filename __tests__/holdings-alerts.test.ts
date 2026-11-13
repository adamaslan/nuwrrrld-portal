import { describe, expect, it } from "vitest";
import {
  canReceiveHoldingsAlerts,
  DEFAULT_MAX_ALERTS,
  detectHoldingsAlerts,
  type AlertDirection,
  type SignalSnapshot,
} from "@/lib/holdings-alerts";

const T0 = "2026-11-12T20:00:00Z";
const T1 = "2026-11-13T14:00:00Z";

function snap(
  ticker: string,
  direction: AlertDirection,
  generatedAt: string,
  extra: Partial<SignalSnapshot> = {},
): SignalSnapshot {
  return { ticker, direction, generatedAt, isStale: false, dataQualityScore: "fresh", ...extra };
}

describe("detectHoldingsAlerts", () => {
  it("reports a reversal, a turn and a fade, most important first", () => {
    const alerts = detectHoldingsAlerts({
      holdings: ["AAA", "BBB", "CCC"],
      previous: [snap("AAA", "bullish", T0), snap("BBB", "neutral", T0), snap("CCC", "bearish", T0)],
      current: [snap("AAA", "bearish", T1), snap("BBB", "bullish", T1), snap("CCC", "neutral", T1)],
    });
    expect(alerts.map((a) => [a.ticker, a.kind])).toEqual([
      ["AAA", "reversed"],
      ["BBB", "turned"],
      ["CCC", "faded"],
    ]);
    expect(alerts[0].message).toBe("$AAA: the signal moved from bullish to bearish.");
  });

  it("says nothing when the direction is unchanged", () => {
    expect(
      detectHoldingsAlerts({
        holdings: ["AAA"],
        previous: [snap("AAA", "bullish", T0)],
        current: [snap("AAA", "bullish", T1)],
      }),
    ).toEqual([]);
  });

  it("says nothing about a ticker with no previous baseline", () => {
    expect(
      detectHoldingsAlerts({ holdings: ["AAA"], previous: [], current: [snap("AAA", "bullish", T1)] }),
    ).toEqual([]);
  });

  it("says nothing about a ticker with no current signal", () => {
    expect(
      detectHoldingsAlerts({ holdings: ["AAA"], previous: [snap("AAA", "bullish", T0)], current: [] }),
    ).toEqual([]);
  });

  it("ignores tickers the user does not hold", () => {
    expect(
      detectHoldingsAlerts({
        holdings: ["AAA"],
        previous: [snap("ZZZ", "bullish", T0)],
        current: [snap("ZZZ", "bearish", T1)],
      }),
    ).toEqual([]);
  });

  it("refuses a stale or unknown-quality current signal", () => {
    const base = { holdings: ["AAA"], previous: [snap("AAA", "bullish", T0)] };
    expect(detectHoldingsAlerts({ ...base, current: [snap("AAA", "bearish", T1, { isStale: true })] })).toEqual([]);
    expect(
      detectHoldingsAlerts({ ...base, current: [snap("AAA", "bearish", T1, { dataQualityScore: "stale" })] }),
    ).toEqual([]);
    expect(
      detectHoldingsAlerts({ ...base, current: [snap("AAA", "bearish", T1, { dataQualityScore: "unknown" })] }),
    ).toEqual([]);
  });

  it("refuses a current signal that is not newer than the previous one", () => {
    const base = { holdings: ["AAA"], previous: [snap("AAA", "bullish", T1)] };
    expect(detectHoldingsAlerts({ ...base, current: [snap("AAA", "bearish", T1)] })).toEqual([]);
    expect(detectHoldingsAlerts({ ...base, current: [snap("AAA", "bearish", T0)] })).toEqual([]);
  });

  it("refuses an unparsable timestamp", () => {
    expect(
      detectHoldingsAlerts({
        holdings: ["AAA"],
        previous: [snap("AAA", "bullish", T0)],
        current: [snap("AAA", "bearish", "not-a-date")],
      }),
    ).toEqual([]);
  });

  it("normalizes tickers and drops invalid holdings", () => {
    const alerts = detectHoldingsAlerts({
      holdings: [" aaa ", "../x", ""],
      previous: [snap("AAA", "bullish", T0)],
      current: [snap("aaa", "bearish", T1)],
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].ticker).toBe("AAA");
  });

  it("produces the same key for the same change, a different key for a later one", () => {
    const run = (at: string) =>
      detectHoldingsAlerts({
        holdings: ["AAA"],
        previous: [snap("AAA", "bullish", T0)],
        current: [snap("AAA", "bearish", at)],
      })[0].key;
    expect(run(T1)).toBe(run(T1));
    expect(run(T1)).not.toBe(run("2026-11-14T14:00:00Z"));
  });

  it("keeps the newest snapshot when a ticker appears twice", () => {
    const alerts = detectHoldingsAlerts({
      holdings: ["AAA"],
      previous: [snap("AAA", "bullish", T0)],
      current: [snap("AAA", "neutral", "2026-11-13T10:00:00Z"), snap("AAA", "bearish", T1)],
    });
    expect(alerts[0].to).toBe("bearish");
  });

  it("caps the number of alerts and honors a zero cap", () => {
    const tickers = Array.from({ length: 30 }, (_, i) => `T${String.fromCharCode(65 + (i % 26))}${i >= 26 ? "X" : ""}`);
    const prev = tickers.map((t) => snap(t, "bullish", T0));
    const curr = tickers.map((t) => snap(t, "bearish", T1));
    expect(detectHoldingsAlerts({ holdings: tickers, previous: prev, current: curr })).toHaveLength(DEFAULT_MAX_ALERTS);
    expect(detectHoldingsAlerts({ holdings: tickers, previous: prev, current: curr, maxAlerts: 3 })).toHaveLength(3);
    expect(detectHoldingsAlerts({ holdings: tickers, previous: prev, current: curr, maxAlerts: 0 })).toEqual([]);
  });

  it("does not use advisory wording", () => {
    const [a] = detectHoldingsAlerts({
      holdings: ["AAA"],
      previous: [snap("AAA", "bullish", T0)],
      current: [snap("AAA", "bearish", T1)],
    });
    expect(a.message).not.toMatch(/\b(buy|sell|should|consider|recommend)\b/i);
  });
});

describe("canReceiveHoldingsAlerts", () => {
  it("is a Pro feature", () => {
    expect(canReceiveHoldingsAlerts("free")).toBe(false);
    expect(canReceiveHoldingsAlerts("pro")).toBe(true);
  });
});
