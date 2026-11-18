/**
 * se1/volume-scans — S26-044, S26-048, S26-050, S26-051. Pure logic over daily bars; no I/O, no model call.
 *
 * Every function takes bars and a decision cutoff. Bars after the cutoff are never read. A state that depends on
 * bars not yet observed is "pending", never "failed" or "held". Missing data is counted, never filled.
 */

export interface VolumeBar {
  /** Session date, YYYY-MM-DD. */
  date: string;
  close: number | null;
  volume: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new RangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
}

/** Bars at or before the cutoff, sorted, with the count of bars excluded for being later. */
function observed(bars: readonly VolumeBar[], cutoff: string): { visible: VolumeBar[]; excluded_after_cutoff: number } {
  requireIsoDate(cutoff, "cutoff");
  for (const b of bars) requireIsoDate(b.date, "bar date");
  const sorted = [...bars].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const visible = sorted.filter((b) => b.date <= cutoff);
  for (const b of visible) {
    if (b.close !== null && (!Number.isFinite(b.close) || b.close < 0)) throw new RangeError(`invalid close on ${b.date}`);
    if (b.volume !== null && (!Number.isFinite(b.volume) || b.volume < 0)) throw new RangeError(`invalid volume on ${b.date}`);
  }
  return { visible, excluded_after_cutoff: sorted.length - visible.length };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── S26-044 Participation-adjusted breakout contrast ──────────────────────────

export interface BreakoutOptions {
  cutoff: string;
  /** Prior sessions that set the breakout level and the volume baseline. Integer, at least 2. */
  baselineWindow: number;
  /** Sessions after the breakout that decide hold or fail. Integer, at least 1. */
  holdWindow: number;
}

export type BreakoutState = "held" | "failed" | "pending" | "unavailable";

export interface BreakoutEvent {
  breakout_date: string;
  breakout_level: number;
  relative_volume: number | null;
  state: BreakoutState;
  /** Bars observed after the breakout, up to the hold window. Pending when this is short of holdWindow. */
  observed_after: number;
}

export type BreakoutResult =
  | { status: "computed"; events: BreakoutEvent[]; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/**
 * A breakout is a close above the highest close of the prior baselineWindow sessions. Relative volume is the
 * breakout session's volume over the median volume of that same prior window. The state is held when every
 * observed close in the hold window stays above the level, failed when any closes back below it, and pending
 * when the hold window has not been fully observed by the cutoff.
 */
export function breakoutParticipation(bars: readonly VolumeBar[], options: BreakoutOptions): BreakoutResult {
  const { baselineWindow, holdWindow } = options;
  if (!Number.isInteger(baselineWindow) || baselineWindow < 2) throw new RangeError(`baselineWindow must be an integer of at least 2`);
  if (!Number.isInteger(holdWindow) || holdWindow < 1) throw new RangeError(`holdWindow must be an integer of at least 1`);
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  if (visible.length < baselineWindow + 1) {
    return { status: "unsupported", reason: `insufficient history: ${visible.length} bars at or before cutoff` };
  }

  const events: BreakoutEvent[] = [];
  for (let i = baselineWindow; i < visible.length; i++) {
    const prior = visible.slice(i - baselineWindow, i);
    const cur = visible[i];
    const priorCloses = prior.flatMap((b) => (b.close === null ? [] : [b.close]));
    if (cur.close === null || priorCloses.length < baselineWindow) continue;
    const level = Math.max(...priorCloses);
    if (cur.close <= level) continue;

    const priorVolumes = prior.flatMap((b) => (b.volume === null ? [] : [b.volume]));
    const relative_volume = cur.volume !== null && priorVolumes.length > 0 && median(priorVolumes) > 0
      ? cur.volume / median(priorVolumes)
      : null;

    const after = visible.slice(i + 1, i + 1 + holdWindow);
    const closesAfter = after.flatMap((b) => (b.close === null ? [] : [b.close]));
    let state: BreakoutState;
    if (closesAfter.some((c) => c <= level)) state = "failed";
    else if (after.length < holdWindow) state = "pending";
    else if (closesAfter.length < after.length) state = "unavailable";
    else state = "held";

    events.push({ breakout_date: cur.date, breakout_level: level, relative_volume, state, observed_after: after.length });
  }
  return { status: "computed", events, excluded_after_cutoff };
}

// ── S26-048 Quiet-pullback versus abandonment contrast ────────────────────────

export interface PullbackOptions {
  cutoff: string;
  /** Sessions for the trend average and the volume baseline. Integer, at least 5. */
  window: number;
  /** Minimum median dollar volume over the window for the name to count as liquid. */
  floorUsd: number;
  /** A pullback is at least this fraction below the highest close of the window. */
  minPullback: number;
  /** Volume in the pullback below this fraction of the baseline reads as reduced. */
  reducedVolume: number;
}

export type PullbackClass = "quiet_pullback" | "abandonment_candidate" | "illiquid" | "not_applicable";

export type PullbackResult =
  | { status: "computed"; classification: PullbackClass; volume_ratio: number | null; trend_intact: boolean; liquid: boolean }
  | { status: "unsupported"; reason: string };

/**
 * Classifies a reduced-volume pullback. Liquidity comes first: a name below the dollar-volume floor is illiquid,
 * and reduced volume there says nothing about interest. Among liquid names, a pullback on reduced volume with
 * the trend average still intact reads as quiet; with the trend average broken it reads as an abandonment
 * candidate, not a healthy pullback.
 */
export function quietPullbackContrast(bars: readonly VolumeBar[], options: PullbackOptions): PullbackResult {
  const { window, floorUsd, minPullback, reducedVolume } = options;
  if (!Number.isInteger(window) || window < 5) throw new RangeError(`window must be an integer of at least 5`);
  if (!Number.isFinite(floorUsd) || floorUsd <= 0) throw new RangeError(`floorUsd must be above zero`);
  if (!(minPullback > 0 && minPullback < 1)) throw new RangeError(`minPullback must be between 0 and 1`);
  if (!(reducedVolume > 0)) throw new RangeError(`reducedVolume must be above zero`);
  const { visible } = observed(bars, options.cutoff);
  if (visible.length < window) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };

  const span = visible.slice(visible.length - window);
  const last = span[span.length - 1];
  const closes = span.flatMap((b) => (b.close === null ? [] : [b.close]));
  const usable = span.flatMap((b) => (b.close === null || b.volume === null ? [] : [b.close * b.volume]));
  const liquid = usable.length >= window / 2 && median(usable) >= floorUsd;
  if (closes.length === 0 || last.close === null) return { status: "unsupported", reason: "no usable close at the cutoff" };

  const peak = Math.max(...closes);
  const pulledBack = last.close <= peak * (1 - minPullback);
  const trendAverage = closes.reduce((a, c) => a + c, 0) / closes.length;
  const trend_intact = last.close >= trendAverage;

  const earlierVolumes = span.slice(0, -1).flatMap((b) => (b.volume === null ? [] : [b.volume]));
  const baseline = earlierVolumes.length > 0 ? median(earlierVolumes) : 0;
  const volume_ratio = last.volume !== null && baseline > 0 ? last.volume / baseline : null;

  let classification: PullbackClass;
  if (!liquid) classification = "illiquid";
  else if (!pulledBack || volume_ratio === null || volume_ratio >= reducedVolume) classification = "not_applicable";
  else classification = trend_intact ? "quiet_pullback" : "abandonment_candidate";

  return { status: "computed", classification, volume_ratio, trend_intact, liquid };
}

// ── S26-050 Volume-price confirmation lag ─────────────────────────────────────

export interface LagOptions {
  cutoff: string;
  /** Prior sessions that set the price-break level. Integer, at least 2. */
  breakWindow: number;
  /** Sessions after the break in which confirmation may occur. Integer, at least 1. */
  confirmWindow: number;
  /** Confirmation is a session whose volume is at least this multiple of the break window's median volume. */
  confirmMultiple: number;
}

export type LagRecord =
  | { break_date: string; status: "confirmed"; confirm_date: string; lag_bars: number }
  | { break_date: string; status: "unconfirmed"; censored: false; lag_bars: null }
  | { break_date: string; status: "unavailable"; censored: false; lag_bars: null }
  | { break_date: string; status: "pending"; censored: true; lag_bars: null; observed_after: number };

export type LagResult =
  | { status: "computed"; records: LagRecord[]; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/**
 * For each close-based price break, records the elapsed observed bars until the first qualifying confirmation.
 * A break whose confirmation window is still open at the cutoff is pending and censored, never failed. A break
 * whose full window closed without confirmation is unconfirmed. Confirmation is never backdated: a session is only
 * ever compared with the break that came before it.
 */
export function confirmationLag(bars: readonly VolumeBar[], options: LagOptions): LagResult {
  const { breakWindow, confirmWindow, confirmMultiple } = options;
  if (!Number.isInteger(breakWindow) || breakWindow < 2) throw new RangeError(`breakWindow must be an integer of at least 2`);
  if (!Number.isInteger(confirmWindow) || confirmWindow < 1) throw new RangeError(`confirmWindow must be an integer of at least 1`);
  if (!(confirmMultiple > 0)) throw new RangeError(`confirmMultiple must be above zero`);
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  if (visible.length < breakWindow + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };

  const records: LagRecord[] = [];
  for (let i = breakWindow; i < visible.length; i++) {
    const prior = visible.slice(i - breakWindow, i);
    const cur = visible[i];
    const priorCloses = prior.flatMap((b) => (b.close === null ? [] : [b.close]));
    if (cur.close === null || priorCloses.length < breakWindow) continue;
    if (cur.close <= Math.max(...priorCloses)) continue;

    const priorVolumes = prior.flatMap((b) => (b.volume === null ? [] : [b.volume]));
    const baseline = priorVolumes.length > 0 ? median(priorVolumes) : 0;
    const after = visible.slice(i + 1, i + 1 + confirmWindow);
    const hit = baseline > 0
      ? after.findIndex((b) => b.volume !== null && b.volume >= confirmMultiple * baseline)
      : -1;

    if (hit >= 0) {
      records.push({ break_date: cur.date, status: "confirmed", confirm_date: after[hit].date, lag_bars: hit + 1 });
    } else if (after.length < confirmWindow) {
      records.push({ break_date: cur.date, status: "pending", censored: true, lag_bars: null, observed_after: after.length });
    } else if (after.some((b) => b.volume === null)) {
      records.push({ break_date: cur.date, status: "unavailable", censored: false, lag_bars: null });
    } else {
      records.push({ break_date: cur.date, status: "unconfirmed", censored: false, lag_bars: null });
    }
  }
  return { status: "computed", records, excluded_after_cutoff };
}

// ── S26-051 Candidate capacity screen ─────────────────────────────────────────

export interface CapacityOptions {
  cutoff: string;
  /** Trailing sessions for the dollar-volume baseline. Integer, at least 1. */
  window: number;
  /** Hypothetical notional in USD supplied by the user. Null or undefined means unknown, which is missing, not zero. */
  notionalUsd: number | null | undefined;
  /** Declared fractions of trailing dollar volume to report against. Each in (0, 1]. */
  fractions: readonly number[];
}

export type CapacityResult =
  | {
      status: "computed";
      notional_usd: number;
      trailing_median_dollar_volume: number;
      ratios: { fraction: number; ratio: number; within: boolean }[];
      labels: string[];
    }
  | { status: "missing"; reason: string }
  | { status: "unsupported"; reason: string };

/**
 * Compares a user-supplied hypothetical notional with declared fractions of trailing dollar volume. Nothing is
 * sent, and nothing is inferred about holdings. Daily volume cannot establish intraday fill quality, spread, or
 * executable capacity, and the labels say so.
 */
export function candidateCapacity(bars: readonly VolumeBar[], options: CapacityOptions): CapacityResult {
  const { window, notionalUsd, fractions } = options;
  if (!Number.isInteger(window) || window < 1) throw new RangeError(`window must be an integer of at least 1`);
  for (const f of fractions) if (!(f > 0 && f <= 1)) throw new RangeError(`fractions must each be in (0, 1]`);
  if (notionalUsd === null || notionalUsd === undefined) return { status: "missing", reason: "notional not supplied" };
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) throw new RangeError(`notionalUsd must be finite and above zero`);

  const { visible } = observed(bars, options.cutoff);
  const span = visible.slice(Math.max(0, visible.length - window));
  const usd = span.flatMap((b) => (b.close === null || b.volume === null ? [] : [b.close * b.volume]));
  if (usd.length === 0) return { status: "unsupported", reason: "no usable trailing dollar volume" };

  const trailing = median(usd);
  return {
    status: "computed",
    notional_usd: notionalUsd,
    trailing_median_dollar_volume: trailing,
    ratios: fractions.map((fraction) => {
      const ratio = notionalUsd / (trailing * fraction);
      return { fraction, ratio, within: ratio <= 1 };
    }),
    labels: [
      "daily dollar volume only",
      "no intraday fill quality, spread, or executable capacity",
      "hypothetical notional; no order is sent and no holding is inferred",
    ],
  };
}
