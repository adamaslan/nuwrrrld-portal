/**
 * 50/200 SMA cross detector — a port of signals-app's
 * `MovingAverageSignalDetector` / `ExpandedMACrossDetector`, with the D1 fix
 * from FIB-ICHIMOKU-MA.md §8 row 1 applied directly: the golden/death cross
 * is emitted from exactly one place (never duplicated across a "trend"
 * detector and a "cross" detector), and D3/D9 grades it `BULLISH`/`BEARISH`
 * rather than `STRONG` — a plain 50/200 cross is common enough that
 * `STRONG` overstates it (see FIBONACCI.md §8.1 for the same question on
 * the fib side).
 */
import { frameLength, sliceFrame, type Frame } from "../frame";
import { buildMaColumns, lastCross } from "../indicators/ma";
import type { Detector, EngineSignal } from "./types";

export const MA_CROSS_CATEGORY = "MA_CROSS";
export const MIN_BARS = 200;

export class MaCrossDetector implements Detector {
  readonly name: string;

  constructor(options: { experimental?: boolean } = {}) {
    this.name = options.experimental ? "ma-cross-experimental" : "ma-cross";
  }

  detect(frame: Frame): EngineSignal[] {
    const n = frameLength(frame);
    if (n < MIN_BARS) return [];
    const { sma50, sma200 } = buildMaColumns(frame);
    const event = lastCross(sma50, sma200);
    if (!event) return [];
    const i = n - 1;
    return [
      {
        signal: event === "GOLDEN" ? "50/200 GOLDEN CROSS" : "50/200 DEATH CROSS",
        description:
          event === "GOLDEN"
            ? `SMA50 (${sma50[i].toFixed(2)}) crossed above SMA200 (${sma200[i].toFixed(2)})`
            : `SMA50 (${sma50[i].toFixed(2)}) crossed below SMA200 (${sma200[i].toFixed(2)})`,
        strength: event === "GOLDEN" ? "BULLISH" : "BEARISH",
        category: MA_CROSS_CATEGORY,
      },
    ];
  }
}

/** Point-in-time detect at bar index `end`, matching the fibonacci detector test pattern. */
export function detectAt(frame: Frame, end: number, detector: Detector = new MaCrossDetector()): EngineSignal[] {
  return detector.detect(sliceFrame(frame, end));
}
