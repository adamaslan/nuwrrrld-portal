/**
 * Ichimoku indicators — a port of signals-app indicators/ichimoku.py, with
 * the D5/D6/T1 causality fixes from homebase/harness/FIB-ICHIMOKU-MA.md
 * baked in from the start rather than ported-then-fixed:
 *
 *  - `Ichimoku_LeadA` / `Ichimoku_LeadB` are computed **unshifted** (the
 *    value at bar i uses only bars ≤ i). The traditional chart convention
 *    projects the cloud 26 bars into the future for *display*; this port
 *    never does that shift internally, so nothing downstream can
 *    accidentally read a value that depends on bars that haven't happened
 *    yet (T1).
 *  - `Chikou_Diff = Close[i] − Close[i−26]` replaces the traditional
 *    `Close.shift(-26)` "lagging span" (D5). The old form is a *negative*
 *    shift — it looks 26 bars into the future — which fails T1 outright.
 *    `Chikou_Diff` answers the same "is price above where it was 26 bars
 *    ago" question causally: positive means yes.
 *  - No `Ichimoku_Chikou = Close.shift(-26)` column exists in this port at
 *    all (D6): mcp-finance1's negative-shift version is the thing being
 *    removed, not something to re-introduce here.
 *  - States (cloud position, cloud colour) are intentionally **not**
 *    computed as a votable EngineSignal anywhere in this file — see D2/T5
 *    in detectors/ichimoku.ts. This module only exports the line values;
 *    only detectors/ichimoku.ts turns the TK cross into a signal.
 */
import type { Frame } from "../frame";

export const TENKAN_PERIOD = 9;
export const KIJUN_PERIOD = 26;
export const SENKOU_B_PERIOD = 52;
export const CHIKOU_LOOKBACK = 26;

/** Rolling max; NaN until `window` values exist. */
function rollingMax(values: readonly number[], window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < window) {
      out.push(NaN);
      continue;
    }
    let max = -Infinity;
    for (let j = i + 1 - window; j <= i; j++) max = Math.max(max, values[j]);
    out.push(max);
  }
  return out;
}

/** Rolling min; NaN until `window` values exist. */
function rollingMin(values: readonly number[], window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < window) {
      out.push(NaN);
      continue;
    }
    let min = Infinity;
    for (let j = i + 1 - window; j <= i; j++) min = Math.min(min, values[j]);
    out.push(min);
  }
  return out;
}

/**
 * (highest high + lowest low) / 2 over `window` bars — the Ichimoku "mid()"
 * building block. NaN propagates automatically: rollingMax/rollingMin are
 * NaN until `window` values exist, and `NaN + x` is always NaN, so no
 * explicit finiteness check is needed here.
 */
function midSeries(high: readonly number[], low: readonly number[], window: number): number[] {
  const hi = rollingMax(high, window);
  const lo = rollingMin(low, window);
  return hi.map((h, i) => (h + lo[i]) / 2);
}

export interface IchimokuColumns {
  readonly tenkan: readonly number[];
  readonly kijun: readonly number[];
  /** Unshifted Senkou Span A — (tenkan + kijun) / 2 at bar i, no forward projection. */
  readonly leadA: readonly number[];
  /** Unshifted Senkou Span B — mid(52) at bar i, no forward projection. */
  readonly leadB: readonly number[];
  /** Close[i] − Close[i-26]; NaN for the first 26 bars. Causal replacement for the lagging span. */
  readonly chikouDiff: readonly number[];
}

export function buildIchimokuColumns(frame: Pick<Frame, "high" | "low" | "close">): IchimokuColumns {
  const tenkan = midSeries(frame.high, frame.low, TENKAN_PERIOD);
  const kijun = midSeries(frame.high, frame.low, KIJUN_PERIOD);
  const leadA = tenkan.map((t, i) => (t + kijun[i]) / 2);
  const leadB = midSeries(frame.high, frame.low, SENKOU_B_PERIOD);
  const chikouDiff = frame.close.map((c, i) =>
    i >= CHIKOU_LOOKBACK ? c - frame.close[i - CHIKOU_LOOKBACK] : NaN,
  );
  return { tenkan, kijun, leadA, leadB, chikouDiff };
}
