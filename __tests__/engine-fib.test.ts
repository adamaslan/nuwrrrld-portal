import { describe, expect, it } from "vitest";

import {
  buildFrame,
  extension,
  FibonacciDetector,
  frameLength,
  recentLegs,
  retracement,
  runDetectors,
  sliceFrame,
  type Bar,
  type Detector,
  type FibLeg,
} from "@/lib/engine";
import { formatFixed2 } from "@/lib/engine/format";

/**
 * The canonical fib invariants (homebase harness/FIBONACCI.md §7), pinned on
 * the TS engine the same way signals-app tests/test_fibonacci.py pins them on
 * the Python one. The golden-fixture test proves parity; these prove intent,
 * with hand-built bars whose right answer is obvious.
 */

const UP_LEG: FibLeg = { low: 100, high: 200, isUp: true, endIndex: 10 };
const DOWN_LEG: FibLeg = { low: 100, high: 200, isUp: false, endIndex: 10 };

/** Flat 1-point-range bars at `price`, volume 1000. */
function flat(price: number, count: number): Bar[] {
  return Array.from({ length: count }, () => ({ open: price, high: price + 0.5, low: price - 0.5, close: price, volume: 1000 }));
}

/** Linear walk of closes from `from` to `to`, 1-point bar ranges. */
function walk(from: number, to: number, steps: number): Bar[] {
  return Array.from({ length: steps }, (_, k) => {
    const c = from + ((to - from) * (k + 1)) / steps;
    return { open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 };
  });
}

/**
 * Up-leg 100 → 130 with confirmed pivots, then a pullback into the golden
 * pocket. Returns the bars before the final (reaction) bar, plus the pocket.
 */
function upLegIntoPocket(): { bars: Bar[]; pocketLo: number; pocketHi: number } {
  const bars = [...flat(100, 25), ...walk(100, 130, 12), ...flat(130, 1), ...walk(130, 112, 8)];
  const leg: FibLeg = { low: 99.5, high: 130.5, isUp: true, endIndex: 0 };
  return { bars, pocketLo: retracement(leg, 0.65), pocketHi: retracement(leg, 0.618) };
}

describe("direction-aware levels (invariant 2)", () => {
  it("measures an up-leg's retracement down from the high", () => {
    expect(retracement(UP_LEG, 0.618)).toBeCloseTo(138.2, 10);
    expect(extension(UP_LEG, 1.618)).toBeCloseTo(261.8, 10);
  });

  it("measures a down-leg's retracement up from the low", () => {
    expect(retracement(DOWN_LEG, 0.618)).toBeCloseTo(161.8, 10);
    expect(extension(DOWN_LEG, 1.618)).toBeCloseTo(38.2, 10);
  });
});

describe("causality (invariant 1)", () => {
  it("gives the same output at bar i for a slice and for a longer frame re-sliced", () => {
    const { bars } = upLegIntoPocket();
    const long = buildFrame([...bars, ...walk(112, 150, 20)]);
    const detector = new FibonacciDetector({ experimental: true });
    for (let i = 30; i < bars.length; i++) {
      const fromShort = detector.detect(buildFrame(bars.slice(0, i + 1)));
      const fromLong = detector.detect(sliceFrame(long, i));
      expect(fromLong, `bar ${i}`).toEqual(fromShort);
    }
  });

  it("only uses pivots that are confirmed by the current bar", () => {
    const bars = [...flat(100, 25), ...walk(100, 130, 12)];
    const frame = buildFrame(bars);
    const atr = frame.atr[frameLength(frame) - 1];
    // The high at the last bar has no 3 bars after it yet: no up-leg can end there.
    const legs = recentLegs(frame.high, frame.low, atr);
    for (const leg of legs) expect(leg.endIndex).toBeLessThanOrEqual(frameLength(frame) - 1 - 3);
  });
});

describe("events, not proximity (invariants 3 and 4)", () => {
  it("emits nothing when a bar sits in the pocket without reversing", () => {
    const { bars, pocketLo, pocketHi } = upLegIntoPocket();
    const mid = (pocketLo + pocketHi) / 2;
    const sitting: Bar = { open: mid, high: mid + 0.3, low: mid - 0.3, close: mid - 0.1, volume: 5000 };
    expect(new FibonacciDetector({ experimental: true }).detect(buildFrame([...bars, sitting]))).toEqual([]);
  });

  it("does not count a bar that breaches through the pocket as a hold", () => {
    const { bars, pocketLo, pocketHi } = upLegIntoPocket();
    const breach: Bar = { open: pocketHi + 0.2, high: pocketHi + 2, low: pocketLo - 5, close: pocketHi + 1.5, volume: 5000 };
    const signals = new FibonacciDetector({ experimental: true }).detect(buildFrame([...bars, breach]));
    expect(signals.filter((s) => s.signal.includes("HOLD"))).toEqual([]);
  });

  it("fires the default hold on a volume-confirmed reversal inside the pocket", () => {
    const { bars, pocketLo, pocketHi } = upLegIntoPocket();
    const hold: Bar = { open: pocketHi - 0.1, high: pocketHi + 2, low: pocketLo + 0.1, close: pocketHi + 1.5, volume: 5000 };
    const signals = new FibonacciDetector().detect(buildFrame([...bars, hold]));
    expect(signals.map((s) => [s.signal, s.strength])).toEqual([["FIB GOLDEN POCKET HOLD", "STRONG BULLISH"]]);
  });

  it("keeps the same hold out of the default set on normal volume", () => {
    const { bars, pocketLo, pocketHi } = upLegIntoPocket();
    const quiet: Bar = { open: pocketHi - 0.1, high: pocketHi + 2, low: pocketLo + 0.1, close: pocketHi + 1.5, volume: 500 };
    expect(new FibonacciDetector().detect(buildFrame([...bars, quiet]))).toEqual([]);
  });
});

describe("budget (invariant 6)", () => {
  it("detects on 500 bars well inside half the 500 ms budget", () => {
    const bars: Bar[] = [];
    let price = 100;
    for (let k = 0; k < 500; k++) {
      price *= 1 + 0.02 * Math.sin(k / 7) + 0.001;
      bars.push({ open: price, high: price * 1.01, low: price * 0.99, close: price, volume: 1000 + k });
    }
    const frame = buildFrame(bars);
    const detector = new FibonacciDetector({ experimental: true });
    const started = performance.now();
    detector.detect(frame);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("runDetectors", () => {
  it("records a failing detector as a warning without dropping the others", () => {
    const broken: Detector = { name: "broken", detect: () => { throw new Error("boom"); } };
    const { bars, pocketLo, pocketHi } = upLegIntoPocket();
    const hold: Bar = { open: pocketHi - 0.1, high: pocketHi + 2, low: pocketLo + 0.1, close: pocketHi + 1.5, volume: 5000 };
    const run = runDetectors(buildFrame([...bars, hold]), [broken, new FibonacciDetector()]);
    expect(run.signals.map((s) => s.detector)).toEqual(["fibonacci"]);
    expect(run.warnings).toEqual(["broken failed: boom"]);
    expect(run.degraded).toBe(false);
  });
});

describe("formatFixed2 matches Python's .2f", () => {
  it.each([
    [138.125, "138.12"],
    [0.375, "0.38"],
    [2.675, "2.67"],
    [161.8, "161.80"],
    [-38.125, "-38.12"],
  ])("%d → %s", (value, expected) => {
    expect(formatFixed2(value)).toBe(expected);
  });
});
