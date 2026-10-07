import { describe, it, expect } from "vitest";
import { sortSignals, isSortKey } from "@/lib/shared/signalFilters";
import { adaptLiveSignals, type SignalPayload } from "@/lib/digest";

const sig = (ticker: string, over: Partial<SignalPayload> = {}): SignalPayload => ({
  id: ticker, ticker, direction: "neutral", timeframe: "medium", confidence: "low",
  title: "", explanation: "", indicators: [], generatedAt: "2026-10-06T21:00:00Z", isStale: false, ...over,
});
const order = (list: SignalPayload[]) => list.map(s => s.ticker).join(",");

describe("sortSignals", () => {
  const list = [
    sig("BBB", { dayChangePct: 1.2, score: 0.1 }),
    sig("AAA", { dayChangePct: -2, score: 0.9 }),
    sig("CCC"),
    sig("DDD", { dayChangePct: 3.4, score: -0.5 }),
  ];
  it("day gain: best first, missing last", () => expect(order(sortSignals(list, "dayGain"))).toBe("DDD,BBB,AAA,CCC"));
  it("confluence: highest first (negatives below positives), missing last", () =>
    expect(order(sortSignals(list, "confluence"))).toBe("AAA,BBB,DDD,CCC"));
  it("ticker A–Z and Z–A", () => {
    expect(order(sortSignals(list, "ticker"))).toBe("AAA,BBB,CCC,DDD");
    expect(order(sortSignals(list, "tickerDesc"))).toBe("DDD,CCC,BBB,AAA");
  });
  it("ties break by ticker; does not mutate input", () => {
    const tied = [sig("ZZZ", { score: 0.5 }), sig("AAA", { score: 0.5 })];
    expect(order(sortSignals(tied, "confluence"))).toBe("AAA,ZZZ");
    expect(order(tied)).toBe("ZZZ,AAA");
  });
  it("isSortKey rejects stale saved prefs", () => {
    expect(isSortKey("dayGain")).toBe(true);
    expect(isSortKey("bogus")).toBe(false);
  });
});

describe("adaptLiveSignals day change", () => {
  it("maps returns['1d'] and tolerates absence", () => {
    const d = adaptLiveSignals({ date: "2026-10-06", updated: new Date().toISOString(), symbols: {
      AAA: { returns: { "1d": 1.76 } }, BBB: {}, CCC: { returns: { "1d": null } } } });
    const by = Object.fromEntries(d.signals.map(s => [s.ticker, s.dayChangePct]));
    expect(by).toEqual({ AAA: 1.76, BBB: undefined, CCC: undefined });
  });
});
