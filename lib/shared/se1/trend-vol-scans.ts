/**
 * se1/trend-vol-scans — S26-035, S26-056, S26-057, S26-058, S26-061, S26-065. Pure logic over daily bars; no I/O,
 * no model call.
 *
 * Every function takes bars and a decision cutoff. Bars after the cutoff are never read. Undefined states (zero path
 * length, empty samples, zero ATR) are returned explicitly, never as zero. Missing values are counted, never filled.
 */

export interface OhlcBar {
  /** Session date, YYYY-MM-DD. */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new RangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
}

function observed(bars: readonly OhlcBar[], cutoff: string): { visible: OhlcBar[]; excluded_after_cutoff: number } {
  requireIsoDate(cutoff, "cutoff");
  for (const b of bars) {
    requireIsoDate(b.date, "bar date");
    for (const [name, v] of [["open", b.open], ["high", b.high], ["low", b.low], ["close", b.close]] as const) {
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new RangeError(`invalid ${name} on ${b.date}`);
    }
  }
  const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const visible = sorted.filter((b) => b.date <= cutoff);
  return { visible, excluded_after_cutoff: sorted.length - visible.length };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── S26-035 Trend-versus-chop path efficiency ─────────────────────────────────

export type EfficiencyResult =
  | { status: "computed"; net_displacement: number; path_length: number; efficiency: number | null; undefined_reason: string | null; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/** Net displacement over the window, the cumulative absolute close changes, and their ratio. Zero path is undefined. */
export function pathEfficiency(bars: readonly OhlcBar[], cutoff: string, window: number): EfficiencyResult {
  if (!Number.isInteger(window) || window < 2) throw new RangeError("window must be an integer of at least 2");
  const { visible, excluded_after_cutoff } = observed(bars, cutoff);
  if (visible.length < window) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };
  const closes = visible.slice(visible.length - window).map((b) => b.close);
  if (closes.some((c) => c === null)) return { status: "unsupported", reason: "missing close in window" };
  const c = closes as number[];
  const net = c[c.length - 1] - c[0];
  let path = 0;
  for (let i = 1; i < c.length; i++) path += Math.abs(c[i] - c[i - 1]);
  if (path === 0) {
    return { status: "computed", net_displacement: net, path_length: 0, efficiency: null, undefined_reason: "zero path length", excluded_after_cutoff };
  }
  return { status: "computed", net_displacement: net, path_length: path, efficiency: Math.abs(net) / path, undefined_reason: null, excluded_after_cutoff };
}

// ── S26-056 Upside/downside semivariance balance ──────────────────────────────

export type SemivarianceResult =
  | {
      status: "computed";
      positive_semivariance: number;
      negative_semivariance: number;
      positive_share: number | null;
      n_positive: number;
      n_negative: number;
      n_zero: number;
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

/** Sum of squared daily close returns, split by sign. The share is null when neither side has any return. */
export function semivarianceBalance(bars: readonly OhlcBar[], cutoff: string, window: number): SemivarianceResult {
  if (!Number.isInteger(window) || window < 1) throw new RangeError("window must be an integer of at least 1");
  const { visible, excluded_after_cutoff } = observed(bars, cutoff);
  if (visible.length < window + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };
  const span = visible.slice(visible.length - window - 1);
  let pos = 0;
  let neg = 0;
  let nPos = 0;
  let nNeg = 0;
  let nZero = 0;
  for (let i = 1; i < span.length; i++) {
    const prev = span[i - 1].close;
    const cur = span[i].close;
    if (prev === null || cur === null || prev === 0) continue;
    const r = cur / prev - 1;
    if (r > 0) { pos += r * r; nPos += 1; }
    else if (r < 0) { neg += r * r; nNeg += 1; }
    else nZero += 1;
  }
  if (nPos + nNeg + nZero === 0) return { status: "unsupported", reason: "no usable close returns in window" };
  const total = pos + neg;
  return {
    status: "computed",
    positive_semivariance: pos,
    negative_semivariance: neg,
    positive_share: total > 0 ? pos / total : null,
    n_positive: nPos,
    n_negative: nNeg,
    n_zero: nZero,
    excluded_after_cutoff,
  };
}

// ── S26-057 Gap-versus-session range contribution ─────────────────────────────

export type GapComponentResult =
  | {
      status: "computed";
      median_abs_gap_pct: number;
      median_abs_open_to_close_pct: number;
      median_range_pct: number;
      sessions: number;
      missing_open: number;
      split_like: number;
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

/**
 * Reports three components side by side: the prior-close-to-open gap, the open-to-close move, and the high-low range,
 * each as a median absolute percentage. They are not added together, because they overlap and cross terms are
 * ignored. A session with no open is excluded from the gap component and counted.
 */
export function gapSessionComponents(bars: readonly OhlcBar[], cutoff: string, window: number): GapComponentResult {
  if (!Number.isInteger(window) || window < 2) throw new RangeError("window must be an integer of at least 2");
  const { visible, excluded_after_cutoff } = observed(bars, cutoff);
  if (visible.length < window + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };
  const span = visible.slice(visible.length - window - 1);
  const gaps: number[] = [];
  const oc: number[] = [];
  const ranges: number[] = [];
  let missing_open = 0;
  let split_like = 0;
  for (let i = 1; i < span.length; i++) {
    const prev = span[i - 1].close;
    const cur = span[i];
    if (cur.high !== null && cur.low !== null && prev !== null && prev > 0) ranges.push((cur.high - cur.low) / prev * 100);
    if (cur.open === null || prev === null || prev === 0) {
      missing_open += 1;
    } else {
      const ratio = cur.open / prev;
      if (ratio < 0.5 || ratio > 2) split_like += 1;
      else gaps.push(Math.abs(ratio - 1) * 100);
    }
    if (cur.open !== null && cur.close !== null && cur.open > 0) oc.push(Math.abs(cur.close / cur.open - 1) * 100);
  }
  if (gaps.length === 0 && oc.length === 0 && ranges.length === 0) return { status: "unsupported", reason: "no usable sessions" };
  return {
    status: "computed",
    median_abs_gap_pct: gaps.length > 0 ? median(gaps) : NaN,
    median_abs_open_to_close_pct: oc.length > 0 ? median(oc) : NaN,
    median_range_pct: ranges.length > 0 ? median(ranges) : NaN,
    sessions: span.length - 1,
    missing_open,
    split_like,
    excluded_after_cutoff,
  };
}

// ── S26-058 Range expansion without close progress ────────────────────────────

export type RangeProgressResult =
  | {
      status: "computed";
      range_expansion: number | null;
      net_close_displacement_pct: number;
      path_efficiency: number | null;
      flagged: boolean;
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

/**
 * Flags a window where the high-low range rises while the close goes nowhere. Range expansion compares the mean
 * range of the second half with the first. The flag needs both expansion above RANGE_EXPANSION and path efficiency
 * below EFFICIENCY_LIMIT. Daily OHLC cannot show the order of moves inside a session, so the flag is a
 * disagreement, not a trend call.
 */
export const RANGE_EXPANSION = 0.25;
export const EFFICIENCY_LIMIT = 0.2;

export function rangeWithoutCloseProgress(bars: readonly OhlcBar[], cutoff: string, window: number): RangeProgressResult {
  if (!Number.isInteger(window) || window < 4) throw new RangeError("window must be an integer of at least 4");
  const { visible, excluded_after_cutoff } = observed(bars, cutoff);
  if (visible.length < window) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };
  const span = visible.slice(visible.length - window);
  if (span.some((b) => b.high === null || b.low === null || b.close === null)) {
    return { status: "unsupported", reason: "missing high, low or close in window" };
  }
  const ranges = span.map((b) => (b.high! - b.low!) / b.close!);
  const half = Math.floor(span.length / 2);
  const firstMean = ranges.slice(0, half).reduce((a, v) => a + v, 0) / half;
  const secondMean = ranges.slice(half).reduce((a, v) => a + v, 0) / (span.length - half);
  const range_expansion = firstMean > 0 ? secondMean / firstMean - 1 : null;

  const closes = span.map((b) => b.close as number);
  const net = closes[closes.length - 1] / closes[0] - 1;
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] / closes[i - 1] - 1);
  const path_efficiency = path > 0 ? Math.abs(net) / path : null;

  return {
    status: "computed",
    range_expansion,
    net_close_displacement_pct: net * 100,
    path_efficiency,
    flagged: range_expansion !== null && range_expansion > RANGE_EXPANSION && path_efficiency !== null && path_efficiency < EFFICIENCY_LIMIT,
    excluded_after_cutoff,
  };
}

// ── S26-061 Low-volatility breakdown distance ─────────────────────────────────

export type BreakdownDistanceResult =
  | {
      status: "computed";
      distance_atr: number | null;
      distance_pct: number;
      atr: number;
      tiny_atr: boolean;
      undefined_reason: string | null;
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

/** A tiny ATR is labeled, not trusted: it gives false precision in ATR units. */
export const TINY_ATR_FRACTION = 0.001;

/**
 * Distance from the last close to a previously confirmed support level, in both ATR and percent. The support level
 * is an input the caller confirmed earlier; this function does not detect it. A zero ATR has an explicit undefined
 * state, not an infinite distance.
 */
export function breakdownDistance(bars: readonly OhlcBar[], cutoff: string, support: number, atrWindow: number): BreakdownDistanceResult {
  if (!Number.isFinite(support) || support <= 0) throw new RangeError("support must be a finite price above zero");
  if (!Number.isInteger(atrWindow) || atrWindow < 2) throw new RangeError("atrWindow must be an integer of at least 2");
  const { visible, excluded_after_cutoff } = observed(bars, cutoff);
  if (visible.length < atrWindow + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };
  const span = visible.slice(visible.length - atrWindow - 1);
  const trs: number[] = [];
  for (let i = 1; i < span.length; i++) {
    const cur = span[i];
    const prevClose = span[i - 1].close;
    if (cur.high === null || cur.low === null || prevClose === null) return { status: "unsupported", reason: "missing high, low or prior close" };
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prevClose), Math.abs(cur.low - prevClose)));
  }
  const atr = trs.reduce((a, v) => a + v, 0) / trs.length;
  const last = span[span.length - 1].close;
  if (last === null) return { status: "unsupported", reason: "no close at cutoff" };
  const distance_pct = (last - support) / last * 100;
  const tiny = atr / last < TINY_ATR_FRACTION;
  if (atr === 0) {
    return { status: "computed", distance_atr: null, distance_pct, atr, tiny_atr: false, undefined_reason: "zero ATR", excluded_after_cutoff };
  }
  return {
    status: "computed",
    distance_atr: (last - support) / atr,
    distance_pct,
    atr,
    tiny_atr: tiny,
    undefined_reason: null,
    excluded_after_cutoff,
  };
}

// ── S26-065 New-high/new-low participation balance ────────────────────────────

export interface MemberCloses {
  ticker: string;
  /** Closes, oldest first, ending on the decision cutoff's session. Bars after the cutoff must be omitted by the caller. */
  closes: readonly (number | null)[];
}

export interface HighLowBalance {
  eligible: number;
  new_highs: number;
  new_lows: number;
  ties_high: number;
  ties_low: number;
  short_history: number;
  missing_last_close: number;
}

/**
 * Counts eligible members making a trailing closing high or low over the lookback, the last close included. A member
 * with fewer closes than the lookback is short-history and is excluded, never called a 52-week extreme. Ties at the
 * extreme are counted separately, not as new extremes.
 */
export function newHighLowBalance(members: readonly MemberCloses[], lookback: number): HighLowBalance {
  if (!Number.isInteger(lookback) || lookback < 2) throw new RangeError("lookback must be an integer of at least 2");
  const out: HighLowBalance = { eligible: 0, new_highs: 0, new_lows: 0, ties_high: 0, ties_low: 0, short_history: 0, missing_last_close: 0 };
  for (const m of members) {
    if (m.closes.length < lookback) { out.short_history += 1; continue; }
    const span = m.closes.slice(m.closes.length - lookback);
    const last = span[span.length - 1];
    if (last === null) { out.missing_last_close += 1; continue; }
    if (span.some((c) => c === null)) { out.short_history += 1; continue; }
    const values = span as number[];
    const others = values.slice(0, -1);
    out.eligible += 1;
    const maxOther = Math.max(...others);
    const minOther = Math.min(...others);
    if (last > maxOther) out.new_highs += 1;
    else if (last === maxOther) out.ties_high += 1;
    if (last < minOther) out.new_lows += 1;
    else if (last === minOther) out.ties_low += 1;
  }
  return out;
}
