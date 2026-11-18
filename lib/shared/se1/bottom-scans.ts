/**
 * se1/bottom-scans — S26-013, 014, 016, 018, 020, 021, 022. Pure logic over daily OHLC bars; no I/O, no model call.
 *
 * Every function takes bars and a decision cutoff. A confirmed pivot is available only after its confirmation bars
 * are observed. A state that needs bars not yet observed is "pending", never "failed", "reclaimed" or "held".
 * Nothing here calls a bottom or a turn; the outputs describe the price sequence.
 */

export interface Bar {
  /** Session date, YYYY-MM-DD. */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function requireIsoDate(value: string, label: string): void {
  if (!ISO_DATE.test(value)) throw new RangeError(`${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
}

function observed(bars: readonly Bar[], cutoff: string): { visible: Bar[]; excluded_after_cutoff: number } {
  requireIsoDate(cutoff, "cutoff");
  for (const b of bars) {
    requireIsoDate(b.date, "bar date");
    for (const [name, v] of [["open", b.open], ["high", b.high], ["low", b.low], ["close", b.close], ["volume", b.volume]] as const) {
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

/** Mean true range over the bars, or null when any input is missing. */
function atrOf(bars: readonly Bar[]): number | null {
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1].close;
    if (cur.high === null || cur.low === null || prev === null) return null;
    trs.push(Math.max(cur.high - cur.low, Math.abs(cur.high - prev), Math.abs(cur.low - prev)));
  }
  return trs.length > 0 ? trs.reduce((a, v) => a + v, 0) / trs.length : null;
}

/**
 * A confirmed close-based low at index i: its close is the minimum of the closes within `k` bars on each side.
 * It counts only once bars i+1..i+k exist, so it is available at the bar that confirms it, never earlier.
 */
export interface Pivot { index: number; date: string; close: number; available_index: number }

export function confirmedLows(visible: readonly Bar[], k: number): Pivot[] {
  if (!Number.isInteger(k) || k < 1) throw new RangeError("confirmation k must be an integer of at least 1");
  const out: Pivot[] = [];
  for (let i = k; i + k < visible.length; i++) {
    const c = visible[i].close;
    if (c === null) continue;
    let isLow = true;
    for (let j = i - k; j <= i + k && isLow; j++) {
      if (j === i) continue;
      const other = visible[j].close;
      if (other === null || other <= c) isLow = false;
    }
    if (isLow) out.push({ index: i, date: visible[i].date, close: c, available_index: i + k });
  }
  return out;
}

// ── S26-013 Failed-breakdown reclaim ──────────────────────────────────────────

export interface ReclaimOptions {
  cutoff: string;
  /** Prior sessions that define the support range. Integer, at least 5. */
  supportWindow: number;
  /** Observed sessions after the breach in which a reclaim may occur. Integer, at least 1. */
  reclaimWindow: number;
  /** ATR window for depth. Integer, at least 2. */
  atrWindow: number;
}

/**
 * "unavailable": the reclaim window has elapsed without a reclaim, but at least one close in it is missing, so a
 * continuing breakdown cannot be established. The window is not extended to later bars to compensate.
 */
export type ReclaimState = "reclaimed" | "continuing_breakdown" | "pending" | "unavailable";

export interface ReclaimEvent {
  breach_date: string;
  support: number;
  depth_atr: number | null;
  state: ReclaimState;
  /** Reclaim close date when reclaimed; the flag is dated here, never at the breach. */
  flag_date: string | null;
}

export type ReclaimResult =
  | { status: "computed"; events: ReclaimEvent[]; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/**
 * A breach is a close below the lowest close of the prior supportWindow bars, the level computed from prefix bars
 * only. A reclaim is a close back above that level within reclaimWindow observed bars. No reclaim within the window is
 * a continuing breakdown, not a reclaim. Fewer observed bars than the window is pending.
 */
export function failedBreakdownReclaim(bars: readonly Bar[], options: ReclaimOptions): ReclaimResult {
  const { supportWindow, reclaimWindow, atrWindow } = options;
  if (!Number.isInteger(supportWindow) || supportWindow < 5) throw new RangeError("supportWindow must be an integer of at least 5");
  if (!Number.isInteger(reclaimWindow) || reclaimWindow < 1) throw new RangeError("reclaimWindow must be an integer of at least 1");
  if (!Number.isInteger(atrWindow) || atrWindow < 2) throw new RangeError("atrWindow must be an integer of at least 2");
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  if (visible.length < supportWindow + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };

  const events: ReclaimEvent[] = [];
  for (let i = supportWindow; i < visible.length; i++) {
    const prefix = visible.slice(i - supportWindow, i);
    const prefixCloses = prefix.flatMap((b) => (b.close === null ? [] : [b.close]));
    const cur = visible[i];
    if (cur.close === null || prefixCloses.length < supportWindow) continue;
    const support = Math.min(...prefixCloses);
    if (cur.close >= support) continue;

    const after = visible.slice(i + 1, i + 1 + reclaimWindow);
    const reclaimAt = after.findIndex((b) => b.close !== null && b.close > support);
    const atrBars = visible.slice(Math.max(0, i - atrWindow), i + 1);
    const atr = atrOf(atrBars);
    const depth_atr = atr !== null && atr > 0 ? (support - cur.close) / atr : null;

    let state: ReclaimState;
    let flag_date: string | null = null;
    if (reclaimAt >= 0) {
      state = "reclaimed";
      flag_date = after[reclaimAt].date;
    } else if (after.length < reclaimWindow) {
      state = "pending";
    } else if (after.some((b) => b.close === null)) {
      state = "unavailable";
    } else {
      state = "continuing_breakdown";
    }
    events.push({ breach_date: cur.date, support, depth_atr, state, flag_date });
  }
  return { status: "computed", events, excluded_after_cutoff };
}

// ── S26-014 Second-low selling-pressure contraction ───────────────────────────

export interface SecondLowOptions {
  cutoff: string;
  /** Confirmation bars on each side of a pivot low. Integer, at least 1. */
  pivotK: number;
  /** Minimum observed bars between the two confirmed lows. Integer, at least 10. */
  minSeparation: number;
  /** ATR window. Integer, at least 2. */
  atrWindow: number;
}

export interface LegStats {
  low_date: string;
  low_close: number;
  down_day_volume_mean: number | null;
  atr_normalized_decline: number | null;
}

export type SecondLowResult =
  | {
      status: "computed";
      pairs: {
        prior: LegStats;
        current: LegStats;
        retest_distance_atr: number | null;
        new_lower_low: boolean;
        heavier_selling: boolean | null;
        /** A new lower low with heavier selling is not exhaustion. The label keeps that visible. */
        exhaustion_label_allowed: boolean;
        available_date: string;
      }[];
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

function legStats(visible: readonly Bar[], pivot: Pivot, prevPivot: Pivot | null, atr: number | null): LegStats {
  const start = prevPivot ? prevPivot.index : Math.max(0, pivot.index - 10);
  const leg = visible.slice(start + 1, pivot.index + 1);
  const downVolumes: number[] = [];
  for (let i = 0; i < leg.length; i++) {
    const idx = start + 1 + i;
    const prev = visible[idx - 1].close;
    const cur = visible[idx];
    if (cur.close !== null && prev !== null && cur.close < prev && cur.volume !== null) downVolumes.push(cur.volume);
  }
  const priorClose = prevPivot ? prevPivot.close : null;
  const decline = priorClose !== null && atr !== null && atr > 0 ? (priorClose - pivot.close) / atr : null;
  return {
    low_date: pivot.date,
    low_close: pivot.close,
    down_day_volume_mean: downVolumes.length > 0 ? downVolumes.reduce((a, v) => a + v, 0) / downVolumes.length : null,
    atr_normalized_decline: decline,
  };
}

export function secondLowContraction(bars: readonly Bar[], options: SecondLowOptions): SecondLowResult {
  const { pivotK, minSeparation, atrWindow } = options;
  if (!Number.isInteger(pivotK) || pivotK < 1) throw new RangeError("pivotK must be an integer of at least 1");
  if (!Number.isInteger(minSeparation) || minSeparation < 10) throw new RangeError("minSeparation must be an integer of at least 10");
  if (!Number.isInteger(atrWindow) || atrWindow < 2) throw new RangeError("atrWindow must be an integer of at least 2");
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  const lows = confirmedLows(visible, pivotK).filter((p) => p.available_index < visible.length);
  if (lows.length < 2) return { status: "unsupported", reason: "fewer than two confirmed lows" };

  const pairs = [];
  for (let i = 1; i < lows.length; i++) {
    const prior = lows[i - 1];
    const current = lows[i];
    if (current.index - prior.index < minSeparation) continue;
    const atr = atrOf(visible.slice(Math.max(0, current.index - atrWindow), current.index + 1));
    const priorStats = legStats(visible, prior, lows[i - 2] ?? null, atrOf(visible.slice(Math.max(0, prior.index - atrWindow), prior.index + 1)));
    const currentStats = legStats(visible, current, prior, atr);
    const new_lower_low = current.close < prior.close;
    const heavier = currentStats.down_day_volume_mean !== null && priorStats.down_day_volume_mean !== null
      ? currentStats.down_day_volume_mean > priorStats.down_day_volume_mean
      : null;
    pairs.push({
      prior: priorStats,
      current: currentStats,
      retest_distance_atr: atr !== null && atr > 0 ? (current.close - prior.close) / atr : null,
      new_lower_low,
      heavier_selling: heavier,
      exhaustion_label_allowed: !(new_lower_low && heavier === true),
      available_date: visible[current.available_index].date,
    });
  }
  if (pairs.length === 0) return { status: "unsupported", reason: `no pair of confirmed lows at least ${minSeparation} bars apart` };
  return { status: "computed", pairs, excluded_after_cutoff };
}

// ── S26-016 Post-capitulation stabilization ───────────────────────────────────

export interface CapitulationOptions {
  cutoff: string;
  /** Sessions for the volume baseline. Integer, at least 5. */
  volumeWindow: number;
  /** Minimum down-close move that counts as an event, as a fraction (0.05 = 5%). */
  minDrop: number;
  /** Event volume at least this multiple of the baseline median. */
  volumeMultiple: number;
  /** Quiet-period sessions that must pass without a new closing low. Integer, at least 1. */
  quietWindow: number;
}

/**
 * "unavailable": the quiet window has elapsed but at least one of its closes is missing, so a quiet period cannot be
 * established. The horizon is not extended to later bars to compensate.
 */
export type StabilizationState = "stabilized" | "cancelled" | "pending" | "unavailable";

export interface CapitulationEvent {
  event_date: string;
  event_close: number;
  drop_pct: number;
  volume_multiple: number;
  state: StabilizationState;
  stabilization_bars: number | null;
  /** Unresolved low is the event close until the quiet period completes; it is never moved to a later low. */
  unresolved_low: number;
}

export type CapitulationResult =
  | { status: "computed"; events: CapitulationEvent[]; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/**
 * A capitulation event is an unusually large down close on high volume. After it, the quiet period is checked
 * against the event close: any close below it cancels the candidate; a full quiet period with no such close
 * stabilizes it. The event is never retimed to a later low, and the capitulation day is never called a bottom.
 */
export function postCapitulationStabilization(bars: readonly Bar[], options: CapitulationOptions): CapitulationResult {
  const { volumeWindow, minDrop, volumeMultiple, quietWindow } = options;
  if (!Number.isInteger(volumeWindow) || volumeWindow < 5) throw new RangeError("volumeWindow must be an integer of at least 5");
  if (!(minDrop > 0 && minDrop < 1)) throw new RangeError("minDrop must be between 0 and 1");
  if (!(volumeMultiple > 0)) throw new RangeError("volumeMultiple must be above zero");
  if (!Number.isInteger(quietWindow) || quietWindow < 1) throw new RangeError("quietWindow must be an integer of at least 1");
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  if (visible.length < volumeWindow + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };

  const events: CapitulationEvent[] = [];
  for (let i = volumeWindow; i < visible.length; i++) {
    const cur = visible[i];
    const prev = visible[i - 1].close;
    if (cur.close === null || prev === null || prev === 0 || cur.volume === null) continue;
    const drop = (cur.close - prev) / prev;
    if (drop > -minDrop) continue;
    const baseline = visible.slice(i - volumeWindow, i).flatMap((b) => (b.volume === null ? [] : [b.volume]));
    if (baseline.length < volumeWindow / 2) continue;
    const med = median(baseline);
    if (med <= 0 || cur.volume < volumeMultiple * med) continue;

    const after = visible.slice(i + 1, i + 1 + quietWindow);
    const broke = after.findIndex((b) => b.close !== null && b.close < cur.close!);
    let state: StabilizationState;
    let stabilization_bars: number | null = null;
    if (broke >= 0) {
      state = "cancelled";
    } else if (after.length < quietWindow) {
      state = "pending";
    } else if (after.some((b) => b.close === null)) {
      state = "unavailable";
    } else {
      state = "stabilized";
      stabilization_bars = quietWindow;
    }
    events.push({
      event_date: cur.date,
      event_close: cur.close,
      drop_pct: drop * 100,
      volume_multiple: cur.volume / med,
      state,
      stabilization_bars,
      unresolved_low: cur.close,
    });
  }
  return { status: "computed", events, excluded_after_cutoff };
}

// ── S26-018 Downside follow-through failure ───────────────────────────────────

export interface FollowThroughOptions {
  cutoff: string;
  /** Prior sessions that define support. Integer, at least 5. */
  supportWindow: number;
  /** Observed sessions after the breakdown. Fixed at three by the spec; kept as an option for tests. */
  followWindow?: number;
}

export type FollowThroughState = "failed_extension" | "continued" | "pending";

export interface FollowThroughEvent {
  breakdown_date: string;
  support: number;
  breakdown_close: number;
  midpoint: number;
  state: FollowThroughState;
  observed_after: number;
}

export type FollowThroughResult =
  | { status: "computed"; events: FollowThroughEvent[]; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/**
 * A bearish close through support is a breakdown. Over the next three observed sessions: if no close goes below the
 * breakdown close and a close regains the midpoint between support and the breakdown close, the follow-through
 * failed. If a close goes below the breakdown close, the decline continued. Otherwise, or while the window is still
 * open, it is pending. A breakdown inside the window of an earlier one is not counted again.
 */
export function downsideFollowThroughFailure(bars: readonly Bar[], options: FollowThroughOptions): FollowThroughResult {
  const { supportWindow } = options;
  const followWindow = options.followWindow ?? 3;
  if (!Number.isInteger(supportWindow) || supportWindow < 5) throw new RangeError("supportWindow must be an integer of at least 5");
  if (!Number.isInteger(followWindow) || followWindow < 1) throw new RangeError("followWindow must be an integer of at least 1");
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  if (visible.length < supportWindow + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };

  const events: FollowThroughEvent[] = [];
  let lastIndex = -Infinity;
  for (let i = supportWindow; i < visible.length; i++) {
    const cur = visible[i];
    const prefix = visible.slice(i - supportWindow, i).flatMap((b) => (b.close === null ? [] : [b.close]));
    if (cur.close === null || prefix.length < supportWindow) continue;
    const support = Math.min(...prefix);
    if (cur.close >= support) continue;
    if (i - lastIndex <= followWindow) continue;
    lastIndex = i;

    const after = visible.slice(i + 1, i + 1 + followWindow);
    const midpoint = (support + cur.close) / 2;
    const extended = after.some((b) => b.close !== null && b.close < cur.close!);
    const regained = after.some((b) => b.close !== null && b.close >= midpoint);
    let state: FollowThroughState;
    if (extended) state = "continued";
    else if (after.length < followWindow || after.some((b) => b.close === null)) state = "pending";
    else state = regained ? "failed_extension" : "pending";
    events.push({ breakdown_date: cur.date, support, breakdown_close: cur.close, midpoint, state, observed_after: after.length });
  }
  return { status: "computed", events, excluded_after_cutoff };
}

// ── S26-020 Gap-down repair ladder ────────────────────────────────────────────

export interface GapRepairOptions {
  cutoff: string;
  /** Minimum downside gap as a fraction of the prior close (0.02 = 2%). */
  minGap: number;
}

export interface GapRepair {
  gap_date: string;
  prior_close: number;
  open: number;
  gap_low: number;
  /** Highest recovered fraction of the gap on a closing bar before any invalidation session, capped at 1. */
  recovered_fraction: number;
  milestones: { fraction: number; date: string | null }[];
  invalidated: boolean;
  invalidation_date: string | null;
}

export type GapRepairResult =
  | { status: "computed"; gaps: GapRepair[]; excluded_split_like: number; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/**
 * A downside gap runs from the prior close down to the open. The repair ladder records the first closing bar at or
 * above 25, 50, 75 and 100 percent of the gap. A later low below the gap day's low invalidates the gap. A split-like
 * open (the open against the prior close outside 0.5x to 2x) is excluded and counted, never read as a gap.
 */
export function gapDownRepairLadder(bars: readonly Bar[], options: GapRepairOptions): GapRepairResult {
  const { minGap } = options;
  if (!(minGap > 0 && minGap < 1)) throw new RangeError("minGap must be between 0 and 1");
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  if (visible.length < 2) return { status: "unsupported", reason: "insufficient history" };

  let excluded_split_like = 0;
  const gaps: GapRepair[] = [];
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1].close;
    const cur = visible[i];
    if (prev === null || prev === 0 || cur.open === null || cur.low === null) continue;
    const ratio = cur.open / prev;
    if (ratio < 0.5 || ratio > 2) { excluded_split_like += 1; continue; }
    if (ratio > 1 - minGap) continue;
    const span = prev - cur.open;
    if (span <= 0) continue;

    const later = visible.slice(i + 1);
    const invasionAt = later.findIndex((b) => b.low !== null && b.low < cur.low!);
    const invasion = invasionAt >= 0 ? later[invasionAt] : undefined;
    // No repair credit on or after the invalidation session. On the invalidating session itself the close is the
    // last print, so it cannot precede the low; daily bars give no finer order, so invalidation takes precedence.
    const creditable = invasionAt >= 0 ? later.slice(0, invasionAt) : later;
    const milestones = [0.25, 0.5, 0.75, 1].map((fraction) => {
      const hit = creditable.find((b) => b.close !== null && (b.close - cur.open!) / span >= fraction);
      return { fraction, date: hit ? hit.date : null };
    });
    let recovered = 0;
    for (const b of creditable) {
      if (b.close === null) continue;
      const f = Math.min(1, (b.close - cur.open) / span);
      if (f > recovered) recovered = f;
    }
    gaps.push({
      gap_date: cur.date,
      prior_close: prev,
      open: cur.open,
      gap_low: cur.low,
      recovered_fraction: recovered,
      milestones,
      invalidated: invasion !== undefined,
      invalidation_date: invasion ? invasion.date : null,
    });
  }
  if (gaps.length === 0 && excluded_split_like === 0) return { status: "unsupported", reason: "no downside gap in history" };
  return { status: "computed", gaps, excluded_split_like, excluded_after_cutoff };
}

// ── S26-021 Repeated downside rejection with close recovery ───────────────────

export interface RejectionOptions {
  cutoff: string;
  /** Sessions that define support as the lowest close. Integer, at least 5. */
  supportWindow: number;
  /** Lower wick at least this fraction of the day's range. */
  minWickFraction: number;
  /** The close must sit at or above this fraction of the day's range from the low. */
  recoverFraction: number;
  /** The day's low must be within this fraction of support. */
  nearSupport: number;
}

export interface Rejection {
  date: string;
  close_confirmed: boolean | null;
}

export type RejectionResult =
  | { status: "computed"; rejections: Rejection[]; rejected_bars: { zero_range: number; split_like: number }; excluded_after_cutoff: number }
  | { status: "unsupported"; reason: string };

/**
 * Counts lower-wick rejections near support whose close recovers a declared fraction of the day's range. A bar with a
 * zero range or a split-like close ratio is rejected as input, not counted. Confirmation is the next observed close
 * above the rejection day's close; with no next bar it is null (pending), not false.
 */
export function downsideRejectionRecovery(bars: readonly Bar[], options: RejectionOptions): RejectionResult {
  const { supportWindow, minWickFraction, recoverFraction, nearSupport } = options;
  if (!Number.isInteger(supportWindow) || supportWindow < 5) throw new RangeError("supportWindow must be an integer of at least 5");
  if (!(minWickFraction > 0 && minWickFraction < 1)) throw new RangeError("minWickFraction must be between 0 and 1");
  if (!(recoverFraction > 0 && recoverFraction <= 1)) throw new RangeError("recoverFraction must be in (0, 1]");
  if (!(nearSupport >= 0)) throw new RangeError("nearSupport must be zero or positive");
  const { visible, excluded_after_cutoff } = observed(bars, options.cutoff);
  if (visible.length < supportWindow + 1) return { status: "unsupported", reason: `insufficient history: ${visible.length} bars` };

  const rejected = { zero_range: 0, split_like: 0 };
  const rejections: Rejection[] = [];
  for (let i = supportWindow; i < visible.length; i++) {
    const cur = visible[i];
    const prev = visible[i - 1].close;
    if (cur.high === null || cur.low === null || cur.close === null) continue;
    const range = cur.high - cur.low;
    if (range <= 0) { rejected.zero_range += 1; continue; }
    if (prev !== null && prev > 0) {
      const ratio = cur.close / prev;
      if (ratio < 0.5 || ratio > 2) { rejected.split_like += 1; continue; }
    }
    const prefix = visible.slice(i - supportWindow, i).flatMap((b) => (b.close === null ? [] : [b.close]));
    if (prefix.length < supportWindow) continue;
    const support = Math.min(...prefix);
    const wick = Math.min(cur.open ?? cur.close, cur.close) - cur.low;
    const nearOk = cur.low <= support * (1 + nearSupport);
    const wickOk = wick / range >= minWickFraction;
    const recovered = (cur.close - cur.low) / range >= recoverFraction;
    if (!(nearOk && wickOk && recovered)) continue;

    const next = visible[i + 1];
    const close_confirmed = next === undefined || next.close === null ? null : next.close > cur.close;
    rejections.push({ date: cur.date, close_confirmed });
  }
  return { status: "computed", rejections, rejected_bars: rejected, excluded_after_cutoff };
}

// ── S26-022 Bottom-pattern disagreement register ──────────────────────────────

export type RowState = "supported" | "contradicted" | "pending" | "unassessable";

export interface RegisterRow {
  id: string;
  state: RowState;
}

export interface Register {
  rows: RegisterRow[];
  counts: Record<RowState, number>;
  /** Only "unassessable" when a required row is missing. Never neutral, and never a high-confidence bottom from a vote. */
  overall: "no_consensus" | "mixed" | "insufficient";
}

/**
 * Collects the state of each bottom row at one cutoff. A missing required row is unassessable, and the overall
 * reading is insufficient rather than neutral. Counts are shown as counts; no majority vote is turned into a probability.
 */
export function bottomDisagreementRegister(rows: readonly RegisterRow[], required: readonly string[]): Register {
  const present = new Map(rows.map((r) => [r.id, r]));
  const full: RegisterRow[] = required.map((id) => present.get(id) ?? { id, state: "unassessable" as RowState });
  const counts: Record<RowState, number> = { supported: 0, contradicted: 0, pending: 0, unassessable: 0 };
  for (const r of full) counts[r.state] += 1;
  let overall: Register["overall"];
  if (counts.unassessable > 0) overall = "insufficient";
  else if (counts.supported > 0 && counts.contradicted > 0) overall = "mixed";
  else overall = "no_consensus";
  return { rows: full, counts, overall };
}
