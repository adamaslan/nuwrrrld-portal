/**
 * Indicator columns the fib engine needs, numerically identical to
 * signals-app indicators/compute.py (`_atr_series`, `_volume_ma_series`).
 */
import type { Bar, Frame } from "./frame";

export const ATR_PERIOD = 14;
export const VOLUME_MA_PERIOD = 20;

/**
 * Wilder ATR: true range smoothed with ewm(alpha = 1/period, adjust = False).
 * The first bar's true range is High − Low (pandas' row max skips the NaN
 * previous close), and the ewm seeds from it.
 */
export function atrSeries(
  high: readonly number[],
  low: readonly number[],
  close: readonly number[],
  period: number = ATR_PERIOD,
): number[] {
  const alpha = 1 / period;
  const out: number[] = [];
  let prev = NaN;
  for (let i = 0; i < close.length; i++) {
    const range = high[i] - low[i];
    const tr =
      i === 0
        ? range
        : Math.max(range, Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    prev = i === 0 ? tr : (1 - alpha) * prev + alpha * tr;
    out.push(prev);
  }
  return out;
}

/** Simple rolling mean; NaN until `window` values exist (pandas rolling().mean()). */
export function rollingMean(values: readonly number[], window: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < window) {
      out.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i + 1 - window; j <= i; j++) sum += values[j];
    out.push(sum / window);
  }
  return out;
}

/** Build a detector-ready frame from raw bars (oldest first). */
export function buildFrame(bars: readonly Bar[]): Frame {
  const open = bars.map((b) => b.open);
  const high = bars.map((b) => b.high);
  const low = bars.map((b) => b.low);
  const close = bars.map((b) => b.close);
  const volume = bars.map((b) => b.volume);
  return {
    open,
    high,
    low,
    close,
    volume,
    atr: atrSeries(high, low, close),
    volumeMa20: rollingMean(volume, VOLUME_MA_PERIOD),
  };
}
