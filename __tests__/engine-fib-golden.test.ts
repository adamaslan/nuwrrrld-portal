import { describe, expect, it } from "vitest";

import golden from "./fixtures/fib-golden.json";
import {
  buildFrame,
  confluenceZones,
  FibonacciDetector,
  recentLegs,
  sliceFrame,
  type Bar,
} from "@/lib/engine";

/**
 * Pins lib/engine's Fibonacci port to signals-app's canonical Python
 * (indicators/pivots.py, indicators/fibonacci.py, detection/fibonacci.py).
 *
 * The fixture was produced by scripts/engine/gen_fib_golden.py running the
 * Python code bar by bar over the same OHLCV, so every expectation here is a
 * Python output. Signals must match exactly (label, strength, description
 * text); prices to 1e-9 relative, the float-ordering slack between languages.
 * Regenerate the fixture, never hand-edit it, when the canonical code changes.
 */
const RELATIVE_TOLERANCE = 1e-9;

type GoldenSignal = { signal: string; description: string; strength: string; category: string };
type GoldenBar = {
  signals?: GoldenSignal[];
  experimentalSignals?: GoldenSignal[];
  atr?: number | null;
  volumeMa20?: number | null;
  legs?: Array<{ low: number; high: number; isUp: boolean; endIndex: number }>;
  zones?: Array<[number, number]>;
};
type GoldenSeries = { name: string; ohlcv: number[][]; bars: GoldenBar[] };

const series = (golden as { series: GoldenSeries[] }).series;

function close(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= RELATIVE_TOLERANCE * Math.max(1, Math.abs(expected));
}

function toBars(ohlcv: number[][]): Bar[] {
  return ohlcv.map(([open, high, low, closePrice, volume]) => ({ open, high, low, close: closePrice, volume }));
}

describe("fib golden fixture (Python parity)", () => {
  it("covers every signal the detector can emit", () => {
    const labels = new Set(
      series.flatMap((s) => s.bars.flatMap((b) => (b.experimentalSignals ?? []).map((x) => `${x.signal}|${x.strength}`))),
    );
    for (const expected of [
      "FIB GOLDEN POCKET HOLD|STRONG BULLISH",
      "FIB CONFLUENCE HOLD|EXTREME BULLISH",
      "FIB 0.786 BREAK|BEARISH",
      "FIB 0.786 BREAK|BULLISH",
      "FIB 1.618 TARGET|SIGNIFICANT",
    ]) {
      expect(labels).toContain(expected);
    }
  });

  for (const s of series) {
    describe(s.name, () => {
      const frame = buildFrame(toBars(s.ohlcv));
      const defaultDetector = new FibonacciDetector();
      const experimentalDetector = new FibonacciDetector({ experimental: true });

      it("emits exactly the Python signals on every bar", () => {
        s.bars.forEach((expected, i) => {
          const view = sliceFrame(frame, i);
          expect(defaultDetector.detect(view), `${s.name} bar ${i} default`).toEqual(expected.signals ?? []);
          expect(experimentalDetector.detect(view), `${s.name} bar ${i} experimental`).toEqual(
            expected.experimentalSignals ?? [],
          );
        });
      });

      it("matches ATR, volume MA, legs and zones on sampled bars", () => {
        s.bars.forEach((expected, i) => {
          if (expected.legs === undefined) return;
          const where = `${s.name} bar ${i}`;
          const atr = frame.atr[i];
          if (expected.atr === null || expected.atr === undefined) {
            expect(Number.isFinite(atr), where).toBe(false);
          } else {
            expect(close(atr, expected.atr), `${where} atr ${atr} vs ${expected.atr}`).toBe(true);
          }
          const volumeMa = frame.volumeMa20[i];
          if (expected.volumeMa20 === null || expected.volumeMa20 === undefined) {
            expect(Number.isNaN(volumeMa), where).toBe(true);
          } else {
            expect(close(volumeMa, expected.volumeMa20), `${where} volumeMa20`).toBe(true);
          }

          const view = sliceFrame(frame, i);
          const legs = Number.isFinite(atr) ? recentLegs(view.high, view.low, atr) : [];
          expect(legs.map((l) => [l.isUp, l.endIndex]), `${where} leg shape`).toEqual(
            expected.legs.map((l) => [l.isUp, l.endIndex]),
          );
          legs.forEach((leg, k) => {
            expect(close(leg.low, expected.legs![k].low) && close(leg.high, expected.legs![k].high), `${where} leg ${k}`).toBe(true);
          });

          const zones = Number.isFinite(atr) ? confluenceZones(legs, atr) : [];
          expect(zones.map((z) => z.legCount), `${where} zone counts`).toEqual((expected.zones ?? []).map(([, n]) => n));
          zones.forEach((zone, k) => {
            expect(close(zone.price, expected.zones![k][0]), `${where} zone ${k}`).toBe(true);
          });
        });
      });
    });
  }
});
