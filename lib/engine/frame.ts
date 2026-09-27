/**
 * Columnar OHLCV frame plus the indicator columns the detectors read.
 *
 * Oldest bar first. Missing indicator values are NaN (never null), mirroring
 * pandas so the ported code can keep the Python guards unchanged.
 */

export interface Bar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Frame {
  readonly open: readonly number[];
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
  readonly volume: readonly number[];
  /** Wilder ATR(14). */
  readonly atr: readonly number[];
  /** Simple 20-bar mean of volume; NaN for the first 19 bars. */
  readonly volumeMa20: readonly number[];
}

export function frameLength(frame: Frame): number {
  return frame.close.length;
}

/**
 * Bars 0..end (inclusive) — the point-in-time view a detector gets at bar
 * `end`. Every indicator column is causal (each value depends only on earlier
 * bars), so slicing a whole-series frame equals recomputing on the slice.
 */
export function sliceFrame(frame: Frame, end: number): Frame {
  const upto = end + 1;
  return {
    open: frame.open.slice(0, upto),
    high: frame.high.slice(0, upto),
    low: frame.low.slice(0, upto),
    close: frame.close.slice(0, upto),
    volume: frame.volume.slice(0, upto),
    atr: frame.atr.slice(0, upto),
    volumeMa20: frame.volumeMa20.slice(0, upto),
  };
}
