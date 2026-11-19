/**
 * se1/price-impact-proxy — S26-47 price-impact proxy regime shift. Pure logic over daily bars; no I/O, no model call.
 *
 * Compares the absolute daily return per $1M of dollar volume across a recent window and the window before it.
 * This is a changing liquidity proxy from daily prices. It is not measured execution slippage, spread, or
 * order-book depth.
 *
 * Exclusions, counted and never silently dropped:
 * - tiny denominators: sessions below the dollar-volume floor
 * - possible unadjusted splits: a close ratio outside [SPLIT_LOW, SPLIT_HIGH] versus the prior close
 * - missing close or volume
 */

export interface ImpactBar {
  /** Session date, YYYY-MM-DD. */
  date: string;
  close: number | null;
  volume: number | null;
}

export interface ImpactOptions {
  /** Decision cutoff, YYYY-MM-DD. Bars after it are excluded and counted. */
  cutoff: string;
  /** Sessions per window. Integer, at least MIN_SESSIONS. */
  window: number;
  /** Dollar-volume floor in USD. Sessions below it are excluded as tiny denominators. */
  floorUsd: number;
}

export const MIN_SESSIONS = 5;
/** Close-to-close ratios outside this band are treated as possible unadjusted splits or corporate actions. */
export const SPLIT_LOW = 0.5;
export const SPLIT_HIGH = 2;
/** Proxy units: absolute daily return per this many dollars of volume. */
export const UNIT_USD = 1_000_000;

export interface WindowLevel {
  median_per_unit: number;
  sessions_used: number;
}

export type ImpactResult =
  | {
      status: "computed";
      window: number;
      recent: WindowLevel;
      prior: WindowLevel;
      /** recent / prior. Null when the prior median is zero. */
      shift_ratio: number | null;
      excluded_tiny: number;
      excluded_split_like: number;
      excluded_missing: number;
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new RangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function priceImpactRegimeShift(bars: readonly ImpactBar[], options: ImpactOptions): ImpactResult {
  const { cutoff, window, floorUsd } = options;
  requireIsoDate(cutoff, "cutoff");
  if (!Number.isInteger(window) || window < MIN_SESSIONS) {
    throw new RangeError(`window must be an integer of at least ${MIN_SESSIONS}, got ${window}`);
  }
  if (!Number.isFinite(floorUsd) || floorUsd <= 0) throw new RangeError(`floorUsd must be finite and above zero, got ${floorUsd}`);

  for (const b of bars) requireIsoDate(b.date, "bar date");

  const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const visible = sorted.filter((b) => b.date <= cutoff);
  for (const b of visible) {
    if (b.close !== null && (!Number.isFinite(b.close) || b.close < 0)) throw new RangeError(`invalid close on ${b.date}`);
    if (b.volume !== null && (!Number.isFinite(b.volume) || b.volume < 0)) throw new RangeError(`invalid volume on ${b.date}`);
  }
  const excluded_after_cutoff = sorted.length - visible.length;

  // Each session needs its prior close, so the two windows need 2 * window + 1 bars.
  const needed = 2 * window + 1;
  if (visible.length < needed) {
    return { status: "unsupported", reason: `insufficient history: ${visible.length} bars at or before cutoff, need ${needed}` };
  }

  const span = visible.slice(visible.length - needed);
  let excluded_tiny = 0;
  let excluded_split_like = 0;
  let excluded_missing = 0;
  // Per-session proxy, aligned with span: index 0 has no prior close inside span and is skipped.
  const proxies: (number | null)[] = [];

  for (let i = 1; i < span.length; i++) {
    const prev = span[i - 1].close;
    const cur = span[i];
    if (prev === null || cur.close === null || cur.volume === null || prev === 0) {
      excluded_missing += 1;
      proxies.push(null);
      continue;
    }
    const ratio = cur.close / prev;
    if (ratio <= SPLIT_LOW || ratio >= SPLIT_HIGH) {
      excluded_split_like += 1;
      proxies.push(null);
      continue;
    }
    const dollarVolume = cur.close * cur.volume;
    if (dollarVolume < floorUsd) {
      excluded_tiny += 1;
      proxies.push(null);
      continue;
    }
    const absReturn = Math.abs(ratio - 1);
    proxies.push(absReturn / (dollarVolume / UNIT_USD));
  }

  // proxies[k] belongs to span[k + 1]. The prior window is the first `window` proxies, the recent one the last.
  const priorSlice = proxies.slice(0, window);
  const recentSlice = proxies.slice(window);

  const levelOf = (slice: (number | null)[]): WindowLevel => {
    const values = slice.flatMap((v) => (v === null ? [] : [v])).sort((a, b) => a - b);
    return values.length === 0 ? { median_per_unit: NaN, sessions_used: 0 } : { median_per_unit: median(values), sessions_used: values.length };
  };
  const prior = levelOf(priorSlice);
  const recent = levelOf(recentSlice);

  if (prior.sessions_used < MIN_SESSIONS || recent.sessions_used < MIN_SESSIONS) {
    return {
      status: "unsupported",
      reason: `insufficient usable sessions: prior ${prior.sessions_used}, recent ${recent.sessions_used}, need ${MIN_SESSIONS} each`,
    };
  }

  return {
    status: "computed",
    window,
    recent,
    prior,
    shift_ratio: prior.median_per_unit > 0 ? recent.median_per_unit / prior.median_per_unit : null,
    excluded_tiny,
    excluded_split_like,
    excluded_missing,
    excluded_after_cutoff,
  };
}
