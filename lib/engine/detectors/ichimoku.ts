/**
 * Ichimoku TK-cross detector — a port of signals-app's `IchimokuDetector`,
 * with the D2/T5 fix applied from the start: cloud position and cloud
 * colour ("PRICE ABOVE KUMO", "BULLISH KUMO") are **states**, not events,
 * and states never vote (T5). The old cloud emitted three trend votes on a
 * bar where literally nothing happened — see FIB-ICHIMOKU-MA.md §10's
 * reproduction, which prints `MA ALIGNMENT BULLISH` / `PRICE ABOVE KUMO` /
 * `BULLISH KUMO` for a bar with no cross at all.
 *
 * This detector emits exactly one thing: the Tenkan/Kijun cross, using the
 * same sign-flip rule as the MA detector (D4), graded `BULLISH`/`BEARISH`
 * rather than `STRONG` (D3). Cloud position and colour are available as
 * plain columns from `buildIchimokuColumns` for anything that wants them as
 * *features* (e.g. regime sizing, PO7 row) — just never as a vote here.
 */
import { frameLength, sliceFrame, type Frame } from "../frame";
import { buildIchimokuColumns } from "../indicators/ichimoku";
import { lastCross } from "../indicators/ma";
import type { Detector, EngineSignal } from "./types";

export const ICHIMOKU_CATEGORY = "ICHIMOKU";
export const MIN_BARS = 52;

export class IchimokuDetector implements Detector {
  readonly name: string;

  constructor(options: { experimental?: boolean } = {}) {
    this.name = options.experimental ? "ichimoku-experimental" : "ichimoku";
  }

  detect(frame: Frame): EngineSignal[] {
    const n = frameLength(frame);
    if (n < MIN_BARS) return [];
    const { tenkan, kijun } = buildIchimokuColumns(frame);
    const event = lastCross(tenkan, kijun);
    if (!event) return [];
    const i = n - 1;
    return [
      {
        signal: event === "GOLDEN" ? "TK CROSS BULLISH" : "TK CROSS BEARISH",
        description:
          event === "GOLDEN"
            ? `Tenkan (${tenkan[i].toFixed(2)}) crossed above Kijun (${kijun[i].toFixed(2)})`
            : `Tenkan (${tenkan[i].toFixed(2)}) crossed below Kijun (${kijun[i].toFixed(2)})`,
        strength: event === "GOLDEN" ? "BULLISH" : "BEARISH",
        category: ICHIMOKU_CATEGORY,
      },
    ];
  }
}

/** Point-in-time detect at bar index `end`, matching the fibonacci detector test pattern. */
export function detectAt(frame: Frame, end: number, detector: Detector = new IchimokuDetector()): EngineSignal[] {
  return detector.detect(sliceFrame(frame, end));
}
