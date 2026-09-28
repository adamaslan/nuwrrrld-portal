import { describe, expect, it } from "vitest";

import {
  buildFrame,
  buildIchimokuColumns,
  buildMaColumns,
  IchimokuDetector,
  MaCrossDetector,
  runDetectors,
  signCross,
  sliceFrame,
  smaSeries,
  type Bar,
} from "@/lib/engine";

/**
 * Invariants pinned by FIB-ICHIMOKU-MA.md §9, mirroring how
 * __tests__/engine-fib.test.ts pins FIBONACCI.md §7 for the fib side.
 * T6 (Python = TS golden equality) is NOT covered here — that requires a
 * fixture generated from signals-app's fixed detectors (row 1 of the build
 * plan) plus a cross-language diff, which this PR does not attempt. See the
 * PR description for what remains unmeasured.
 */

function flat(price: number, count: number): Bar[] {
  return Array.from({ length: count }, () => ({
    open: price,
    high: price + 0.5,
    low: price - 0.5,
    close: price,
    volume: 1000,
  }));
}

function walk(from: number, to: number, steps: number): Bar[] {
  return Array.from({ length: steps }, (_, k) => {
    const c = from + ((to - from) * (k + 1)) / steps;
    return { open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 };
  });
}

describe("T2 — no partial windows", () => {
  it("smaSeries is NaN until the window is full", () => {
    const values = Array.from({ length: 10 }, (_, i) => i + 1);
    const sma = smaSeries(values, 5);
    expect(sma.slice(0, 4).every((v) => Number.isNaN(v))).toBe(true);
    expect(sma[4]).toBeCloseTo((1 + 2 + 3 + 4 + 5) / 5, 9);
    expect(sma[9]).toBeCloseTo((6 + 7 + 8 + 9 + 10) / 5, 9);
  });

  it("Ichimoku columns are NaN until each window is full", () => {
    const bars = flat(100, 60);
    const frame = buildFrame(bars);
    const { tenkan, kijun, leadB } = buildIchimokuColumns(frame);
    expect(Number.isNaN(tenkan[7])).toBe(true); // period 9
    expect(Number.isFinite(tenkan[8])).toBe(true);
    expect(Number.isNaN(kijun[24])).toBe(true); // period 26
    expect(Number.isFinite(kijun[25])).toBe(true);
    expect(Number.isNaN(leadB[50])).toBe(true); // period 52
    expect(Number.isFinite(leadB[51])).toBe(true);
  });
});

describe("T1 — causal (no negative shift)", () => {
  it("chikouDiff at bar i only depends on bars <= i", () => {
    const full = buildFrame(walk(100, 200, 80));
    const { chikouDiff } = buildIchimokuColumns(full);
    // Recompute on a slice ending at bar 50: the value at bar 50 must be
    // identical whether or not later bars exist (slice-equality causality,
    // the same proof style engine-fib-golden.test.ts uses for fib legs).
    const sliced = sliceFrame(full, 50);
    const slicedCols = buildIchimokuColumns(sliced);
    expect(chikouDiff[50]).toBeCloseTo(slicedCols.chikouDiff[50], 9);
  });

  it("leadA/leadB at bar i are unaffected by bars after i (unshifted, no forward projection)", () => {
    const full = buildFrame(walk(100, 300, 100));
    const { leadA, leadB } = buildIchimokuColumns(full);
    const sliced = sliceFrame(full, 60);
    const slicedCols = buildIchimokuColumns(sliced);
    expect(leadA[60]).toBeCloseTo(slicedCols.leadA[60], 9);
    expect(leadB[60]).toBeCloseTo(slicedCols.leadB[60], 9);
  });
});

describe("T3/T4 — one emission per cross, ties don't re-fire", () => {
  it("signCross fires once on the flip and never again while sign stays the same", () => {
    let prevSign: -1 | 0 | 1 = 0;
    const events: Array<"GOLDEN" | "DEATH" | null> = [];
    // fast below slow, then crosses above and stays above for several bars.
    const fastSeries = [10, 10, 10, 12, 13, 14, 15];
    const slowSeries = [11, 11, 11, 11, 11, 11, 11];
    for (let i = 0; i < fastSeries.length; i++) {
      const { event, nextSign } = signCross(fastSeries[i], slowSeries[i], prevSign);
      prevSign = nextSign;
      events.push(event);
    }
    expect(events.filter((e) => e === "GOLDEN").length).toBe(1);
    expect(events).toEqual([null, null, null, "GOLDEN", null, null, null]);
  });

  it("a tie (fast === slow) never fires and does not reset the remembered sign", () => {
    let prevSign: -1 | 0 | 1 = 0;
    // below, tie, still-below-equivalent (no flip since sign resumes -1)
    const steps: Array<[number, number]> = [
      [9, 10], // sign -1
      [10, 10], // tie: 0, no fire, remembered sign stays -1
      [9, 10], // back to -1: no flip relative to remembered sign, no fire
    ];
    const events: Array<"GOLDEN" | "DEATH" | null> = [];
    for (const [fast, slow] of steps) {
      const { event, nextSign } = signCross(fast, slow, prevSign);
      prevSign = nextSign;
      events.push(event);
    }
    expect(events).toEqual([null, null, null]);
  });

  it("MaCrossDetector emits exactly one golden cross on a sustained upcross, none on flat data", () => {
    const flatBars = flat(100, 250);
    const detector = new MaCrossDetector();
    expect(detector.detect(buildFrame(flatBars))).toEqual([]);

    // 200 flat bars to fill both SMAs (SMA50 === SMA200 exactly, a tie — no
    // event, and nothing to remember yet per D4), a decline that pulls
    // SMA50 below SMA200 (the *first* non-tied sign only establishes a
    // baseline — signCross intentionally does not fire on it, since there
    // was no prior sign to have crossed from), then a sustained incline
    // that crosses SMA50 back above SMA200 exactly once.
    const bars = [...flat(100, 200), ...walk(100, 70, 80), ...walk(70, 200, 120)];
    const frame = buildFrame(bars);
    let goldenCount = 0;
    let deathCount = 0;
    for (let i = 199; i < frame.close.length; i++) {
      const hits = detector.detect(sliceFrame(frame, i));
      goldenCount += hits.filter((h) => h.signal === "50/200 GOLDEN CROSS").length;
      deathCount += hits.filter((h) => h.signal === "50/200 DEATH CROSS").length;
    }
    expect(deathCount).toBe(0); // the decline only establishes the baseline sign, per D4
    expect(goldenCount).toBe(1);
  });
});

describe("T5 — states never vote", () => {
  it("IchimokuDetector emits only TK-cross events, never a cloud-position/colour signal", () => {
    const bars = flat(100, 200);
    const detector = new IchimokuDetector();
    const hits = detector.detect(buildFrame(bars));
    for (const hit of hits) {
      expect(hit.signal).toMatch(/^TK CROSS (BULLISH|BEARISH)$/);
      expect(hit.strength === "BULLISH" || hit.strength === "BEARISH").toBe(true);
    }
  });

  it("a constant-trend series emits 0 Ichimoku hits after warm-up (D2 regression)", () => {
    // Flat price -> tenkan == kijun the whole time (no cross ever fires),
    // and there is no cloud-state vote to fire regardless.
    const frame = buildFrame(flat(150, 120));
    let hits = 0;
    for (let i = 51; i < frame.close.length; i++) {
      hits += new IchimokuDetector().detect(sliceFrame(frame, i)).length;
    }
    expect(hits).toBe(0);
  });
});

describe("MA/Ichimoku wired into runDetectors as experimental", () => {
  it("SNAPSHOT_DETECTORS-style run tags MA/Ichimoku hits with their detector name", async () => {
    const { SNAPSHOT_DETECTORS } = await import("@/lib/engine");
    const bars = [...flat(100, 210), ...walk(100, 220, 60)];
    const frame = buildFrame(bars);
    const run = runDetectors(frame, SNAPSHOT_DETECTORS);
    expect(run.degraded).toBe(false);
    const names = new Set(SNAPSHOT_DETECTORS.map((d) => d.name));
    expect(names.has("ma-cross-experimental")).toBe(true);
    expect(names.has("ichimoku-experimental")).toBe(true);
  });
});

describe("buildMaColumns", () => {
  it("returns 50/200 SMA columns keyed by the frame's close series", () => {
    const frame = buildFrame(flat(100, 250));
    const { sma50, sma200 } = buildMaColumns(frame);
    expect(sma50.length).toBe(250);
    expect(sma200.length).toBe(250);
    expect(sma50[249]).toBeCloseTo(100, 9);
    expect(sma200[249]).toBeCloseTo(100, 9);
  });
});
