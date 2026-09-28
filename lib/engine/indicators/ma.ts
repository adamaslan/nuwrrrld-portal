/**
 * Moving-average indicators and the sign-flip cross helper — a port of
 * signals-app indicators/moving_average.py + the D4 fix from
 * homebase/harness/FIB-ICHIMOKU-MA.md §8 row 1: every cross (MA and
 * Ichimoku TK) must use one shared sign-flip rule so a value sitting exactly
 * on the line doesn't re-fire the same cross on every subsequent tied bar.
 *
 * Per FIB-ICHIMOKU-MA.md §11 open decision 2, only the 50/200 pair ships as
 * a production signal here (the "golden cross" / "death cross"); the wider
 * 11-pair research grid stays out of this port until the owner decides to
 * promote more of it (recorded as a reversible default, not a silent call).
 */
import type { Frame } from "../frame";

export const FAST_PERIOD = 50;
export const SLOW_PERIOD = 200;

/** Simple rolling mean; NaN until `window` values exist (T2: no partial windows). */
export function smaSeries(values: readonly number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(i + 1 < window ? NaN : sum / window);
  }
  return out;
}

/** -1, 0 or +1: sign of (fast − slow), NaN-safe (NaN inputs yield 0 — "no relation yet"). */
function sign(fast: number, slow: number): -1 | 0 | 1 {
  if (!Number.isFinite(fast) || !Number.isFinite(slow)) return 0;
  const diff = fast - slow;
  if (diff > 0) return 1;
  if (diff < 0) return -1;
  return 0;
}

export type CrossEvent = "GOLDEN" | "DEATH" | null;

/**
 * Sign-flip cross rule (D4): a cross fires only on the bar where the sign of
 * (fast − slow) actually flips relative to the last *non-zero* sign seen. A
 * tie (diff === 0) never fires and never resets the remembered sign, so a
 * fast/slow pair that sits exactly equal for several bars doesn't re-emit
 * the same cross once it moves back off zero (T3: one emission per event;
 * T4: ties don't re-fire).
 *
 * `prevSign` is the last non-zero sign already observed (0 if none yet).
 * Returns the event (if any) and the sign to remember for the next bar.
 */
export function signCross(
  fast: number,
  slow: number,
  prevSign: -1 | 0 | 1,
): { event: CrossEvent; nextSign: -1 | 0 | 1 } {
  const current = sign(fast, slow);
  if (current === 0) return { event: null, nextSign: prevSign };
  if (prevSign === 0) return { event: null, nextSign: current };
  if (current === prevSign) return { event: null, nextSign: current };
  return { event: current === 1 ? "GOLDEN" : "DEATH", nextSign: current };
}

/**
 * Walk a whole series and return the sign-flip cross event (if any) at the
 * final index, given the series up to and including it. Used by the
 * detector, which only cares about "did a cross happen on the last bar."
 */
export function lastCross(fastSeries: readonly number[], slowSeries: readonly number[]): CrossEvent {
  let prevSign: -1 | 0 | 1 = 0;
  let event: CrossEvent = null;
  for (let i = 0; i < fastSeries.length; i++) {
    const result = signCross(fastSeries[i], slowSeries[i], prevSign);
    prevSign = result.nextSign;
    event = i === fastSeries.length - 1 ? result.event : event;
  }
  return event;
}

export interface MaColumns {
  readonly sma50: readonly number[];
  readonly sma200: readonly number[];
}

export function buildMaColumns(frame: Pick<Frame, "close">): MaColumns {
  return {
    sma50: smaSeries(frame.close, FAST_PERIOD),
    sma200: smaSeries(frame.close, SLOW_PERIOD),
  };
}
