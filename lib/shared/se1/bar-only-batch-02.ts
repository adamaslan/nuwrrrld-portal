/**
 * S26-023..028. Pure diagnostics over daily bars and caller-supplied membership / event context.
 * Every threshold is provisional and configurable. These labels describe price structure; they do not infer intent.
 */

import { parseIso } from "@/lib/shared/se1/util";

export interface DailyBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

function visibleBars(bars: readonly DailyBar[], cutoff: string): DailyBar[] {
  if (parseIso(cutoff) === null) throw new RangeError("cutoff must be a valid ISO date");
  for (const bar of bars) {
    if (parseIso(bar.date) === null) throw new RangeError(`invalid bar date: ${bar.date}`);
    for (const [field, value] of Object.entries(bar)) {
      if (field !== "date" && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new RangeError(`invalid ${field} on ${bar.date}`);
      }
    }
  }
  return bars.filter((bar) => bar.date <= cutoff).slice().sort((a, b) => a.date.localeCompare(b.date));
}

function meanTrueRange(bars: readonly DailyBar[]): number | null {
  const values: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const current = bars[i];
    const prior = bars[i - 1].close;
    if (current.high === null || current.low === null || prior === null) return null;
    values.push(Math.max(current.high - current.low, Math.abs(current.high - prior), Math.abs(current.low - prior)));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

// ── S26-023 Failed-breakout shelf loss ────────────────────────────────────────

export interface ShelfLossEvent {
  breakout_date: string;
  state: "failed" | "held" | "pending" | "unavailable";
  failure_date: string | null;
  failure_depth_atr: number | null;
  observed_after: number;
}

/** The resistance shelf is caller-confirmed before cutoff; no later high is used to create it. */
export function failedBreakoutShelfLoss(bars: readonly DailyBar[], options: {
  cutoff: string;
  shelf: number;
  holdBars: number;
  atrWindow: number;
  breakoutBuffer: number;
}): { status: "computed" | "unsupported"; reason?: string; events?: ShelfLossEvent[]; excluded_after_cutoff?: number } {
  if (!Number.isFinite(options.shelf) || options.shelf <= 0 || !Number.isInteger(options.holdBars) || options.holdBars < 1
    || !Number.isInteger(options.atrWindow) || options.atrWindow < 2 || !Number.isFinite(options.breakoutBuffer) || options.breakoutBuffer < 0) {
    throw new RangeError("shelf, windows, and breakoutBuffer are invalid");
  }
  const visible = visibleBars(bars, options.cutoff);
  if (visible.length < options.atrWindow + 1) return { status: "unsupported", reason: "insufficient history" };
  const events: ShelfLossEvent[] = [];
  for (let i = 1; i < visible.length; i++) {
    const previous = visible[i - 1].close;
    const current = visible[i].close;
    if (previous === null || current === null || previous > options.shelf * (1 + options.breakoutBuffer)
      || current <= options.shelf * (1 + options.breakoutBuffer)) continue;
    const after = visible.slice(i + 1, i + 1 + options.holdBars);
    const failAt = after.findIndex((bar) => bar.close !== null && bar.close < options.shelf);
    const failure = failAt < 0 ? null : after[failAt];
    let state: ShelfLossEvent["state"];
    if (failure) state = "failed";
    else if (after.length < options.holdBars) state = "pending";
    else if (after.some((bar) => bar.close === null)) state = "unavailable";
    else state = "held";
    const atrBars = visible.slice(Math.max(0, i - options.atrWindow), i + 1);
    const atr = meanTrueRange(atrBars);
    const failure_depth_atr = failure && atr !== null && atr > 0 ? (options.shelf - failure.close!) / atr : null;
    events.push({ breakout_date: visible[i].date, state, failure_date: failure?.date ?? null, failure_depth_atr, observed_after: after.length });
  }
  return { status: "computed", events, excluded_after_cutoff: bars.length - visible.length };
}

// ── S26-024 Successive-high participation decay ───────────────────────────────

export interface ParticipationComparison {
  prior_high_date: string;
  current_high_date: string;
  state: "computed" | "unavailable" | "pending";
  approach_up_volume_mean: number | null;
  pullback_down_volume_mean: number | null;
  pullback_to_approach_ratio: number | null;
  available_date: string | null;
}

/** Each confirmed price high is used once; missing/zero volume in a matched leg makes that comparison unavailable. */
export function successiveHighParticipationDecay(bars: readonly DailyBar[], options: {
  cutoff: string;
  pivotK: number;
  minLegBars: number;
}): { status: "computed" | "unsupported"; reason?: string; comparisons?: ParticipationComparison[]; sample_size?: number; excluded_after_cutoff?: number } {
  if (!Number.isInteger(options.pivotK) || options.pivotK < 1 || !Number.isInteger(options.minLegBars) || options.minLegBars < 1) {
    throw new RangeError("pivotK and minLegBars must be positive integers");
  }
  const visible = visibleBars(bars, options.cutoff);
  if (visible.length < 2 * options.pivotK + options.minLegBars + 1) return { status: "unsupported", reason: "insufficient history" };
  const pivots: number[] = [];
  for (let i = options.pivotK; i + options.pivotK < visible.length; i++) {
    const high = visible[i].high;
    if (high === null) continue;
    const neighbors = visible.slice(i - options.pivotK, i + options.pivotK + 1).filter((_, offset) => offset !== options.pivotK);
    if (neighbors.every((bar) => bar.high !== null && bar.high < high)) pivots.push(i);
  }
  const comparisons: ParticipationComparison[] = [];
  for (let p = 1; p < pivots.length; p++) {
    const priorIndex = pivots[p - 1];
    const currentIndex = pivots[p];
    const approach = visible.slice(Math.max(priorIndex + 1, currentIndex - options.minLegBars), currentIndex + 1);
    const pullback = visible.slice(currentIndex + 1, currentIndex + 1 + options.minLegBars);
    const availableIndex = currentIndex + options.minLegBars;
    if (approach.length < options.minLegBars + 1 || pullback.length < options.minLegBars) {
      comparisons.push({ prior_high_date: visible[priorIndex].date, current_high_date: visible[currentIndex].date, state: "pending", approach_up_volume_mean: null, pullback_down_volume_mean: null, pullback_to_approach_ratio: null, available_date: null });
      continue;
    }
    const segments = [...approach, ...pullback];
    const missingOrZero = segments.some((bar) => bar.volume === null || bar.volume === 0 || bar.close === null);
    const approachVolumes: number[] = [];
    for (let i = 1; i < approach.length; i++) {
      if (approach[i].close! > approach[i - 1].close!) approachVolumes.push(approach[i].volume!);
    }
    const pullbackVolumes: number[] = [];
    for (let i = 1; i < pullback.length; i++) {
      if (pullback[i].close! < pullback[i - 1].close!) pullbackVolumes.push(pullback[i].volume!);
    }
    const approachMean = approachVolumes.length ? approachVolumes.reduce((sum, value) => sum + value, 0) / approachVolumes.length : null;
    const pullbackMean = pullbackVolumes.length ? pullbackVolumes.reduce((sum, value) => sum + value, 0) / pullbackVolumes.length : null;
    const comparable = !missingOrZero && approachMean !== null && pullbackMean !== null && approachMean > 0;
    comparisons.push({
      prior_high_date: visible[priorIndex].date, current_high_date: visible[currentIndex].date,
      state: comparable ? "computed" : "unavailable", approach_up_volume_mean: comparable ? approachMean : null,
      pullback_down_volume_mean: comparable ? pullbackMean : null,
      pullback_to_approach_ratio: comparable ? pullbackMean / approachMean : null,
      available_date: visible[availableIndex].date,
    });
  }
  return { status: "computed", comparisons, sample_size: comparisons.filter((item) => item.state === "computed").length, excluded_after_cutoff: bars.length - visible.length };
}

// ── S26-025 Leadership-rank rollover ─────────────────────────────────────────

export interface MemberRankInput {
  ticker: string;
  sector: string;
  prior_date: string;
  current_date: string;
  prior_return: number | null;
  current_return: number | null;
  prior_member: boolean;
  current_member: boolean;
}

/** Ranks the intersection of the supplied prior/current membership snapshots to prevent churn from creating rank loss. */
export function leadershipRankRollover(members: readonly MemberRankInput[], options: {
  cohort_size: number;
  sector_returns: Readonly<Record<string, number | null>>;
  prior_date: string;
  current_date: string;
}): {
  prior_date: string;
  current_date: string;
  denominator: number;
  exclusions: { membership_changed: number; missing_return: number; date_mismatch: number };
  rollovers: { ticker: string; sector: string; prior_rank: number; current_rank: number; sector_residual: number | null }[];
} {
  if (!Number.isInteger(options.cohort_size) || options.cohort_size < 1 || parseIso(options.prior_date) === null
    || parseIso(options.current_date) === null || options.prior_date >= options.current_date) throw new RangeError("invalid cohort or comparison dates");
  if (new Set(members.map((item) => item.ticker)).size !== members.length) throw new RangeError("member tickers must be unique");
  if (members.some((item) => parseIso(item.prior_date) === null || parseIso(item.current_date) === null
    || (item.prior_return !== null && !Number.isFinite(item.prior_return)) || (item.current_return !== null && !Number.isFinite(item.current_return)))) {
    throw new RangeError("member dates and returns must be valid");
  }
  const changed = members.filter((item) => item.prior_member !== item.current_member).length;
  const date_mismatch = members.filter((item) => item.prior_date !== options.prior_date || item.current_date !== options.current_date).length;
  const missing = members.filter((item) => item.prior_member && item.current_member && (item.prior_return === null || item.current_return === null)).length;
  const eligible = members.filter((item) => item.prior_member && item.current_member && item.prior_date === options.prior_date
    && item.current_date === options.current_date && item.prior_return !== null && item.current_return !== null);
  const rank = (key: "prior_return" | "current_return") => new Map([...eligible]
    .sort((a, b) => b[key]! - a[key]! || a.ticker.localeCompare(b.ticker)).map((item, index) => [item.ticker, index + 1]));
  const prior = rank("prior_return");
  const current = rank("current_return");
  const rollovers = eligible.flatMap((item) => {
    const prior_rank = prior.get(item.ticker)!;
    const current_rank = current.get(item.ticker)!;
    const sectorReturn = options.sector_returns[item.sector];
    const sector_residual = sectorReturn === null || sectorReturn === undefined ? null : item.current_return! - sectorReturn;
    if (prior_rank > options.cohort_size || current_rank <= options.cohort_size || sectorReturn === null || sectorReturn === undefined || sectorReturn <= 0) return [];
    return [{ ticker: item.ticker, sector: item.sector, prior_rank, current_rank, sector_residual }];
  });
  return { prior_date: options.prior_date, current_date: options.current_date, denominator: eligible.length, exclusions: { membership_changed: changed, missing_return: missing, date_mismatch }, rollovers };
}

// ── S26-026 Blow-off extension and range reversal ─────────────────────────────

export interface BlowOffEvent {
  extension_date: string;
  extension_atr: number;
  reversal_date: string | null;
  state: "reversed" | "no_reversal" | "pending" | "unavailable";
  event_contamination: "listed_by_caller" | "not_listed_by_caller" | "not_supplied";
}

/** Requires a prior ATR-normalized extension and a later wide-range close inside the frozen pre-extension range. */
export function blowOffExtensionReversal(bars: readonly DailyBar[], options: {
  cutoff: string;
  baselineWindow: number;
  atrWindow: number;
  extensionAtr: number;
  wideRangeAtr: number;
  reversalWindow: number;
  contaminatedDates?: readonly string[];
}): { status: "computed" | "unsupported"; reason?: string; events?: BlowOffEvent[]; excluded_after_cutoff?: number } {
  if (![options.baselineWindow, options.atrWindow, options.reversalWindow].every((value) => Number.isInteger(value) && value >= 2)
    || ![options.extensionAtr, options.wideRangeAtr].every((value) => Number.isFinite(value) && value > 0)) throw new RangeError("invalid windows or thresholds");
  const visible = visibleBars(bars, options.cutoff);
  if (visible.length < Math.max(options.baselineWindow, options.atrWindow + 1) + 1) return { status: "unsupported", reason: "insufficient history" };
  const contaminated = options.contaminatedDates === undefined ? null : new Set(options.contaminatedDates);
  const events: BlowOffEvent[] = [];
  let lastExtensionIndex = -Infinity;
  for (let i = Math.max(options.baselineWindow, options.atrWindow + 1); i < visible.length; i++) {
    const current = visible[i];
    const pre = visible.slice(i - options.baselineWindow, i);
    const atr = meanTrueRange(visible.slice(i - options.atrWindow - 1, i));
    if (pre.some((bar) => bar.close === null || bar.high === null || bar.low === null) || current.close === null || atr === null || atr <= 0) continue;
    const average = pre.reduce((sum, bar) => sum + bar.close!, 0) / pre.length;
    const extension = (current.close - average) / atr;
    if (extension < options.extensionAtr || i <= lastExtensionIndex + options.reversalWindow) continue;
    const referenceHigh = Math.max(...pre.map((bar) => bar.high!));
    const referenceLow = Math.min(...pre.map((bar) => bar.low!));
    const after = visible.slice(i + 1, i + 1 + options.reversalWindow);
    const reversal = after.find((bar) => bar.high !== null && bar.low !== null && bar.close !== null
      && bar.high - bar.low >= options.wideRangeAtr * atr && bar.close >= referenceLow && bar.close <= referenceHigh);
    const state: BlowOffEvent["state"] = reversal ? "reversed"
      : after.length < options.reversalWindow ? "pending"
        : after.some((bar) => bar.high === null || bar.low === null || bar.close === null) ? "unavailable" : "no_reversal";
    const listed = contaminated === null ? "not_supplied" : "not_listed_by_caller";
    const event_contamination = contaminated?.has(current.date) || (reversal && contaminated?.has(reversal.date)) ? "listed_by_caller" : listed;
    events.push({ extension_date: current.date, extension_atr: extension, reversal_date: reversal?.date ?? null, state, event_contamination });
    lastExtensionIndex = i;
  }
  return { status: "computed", events, excluded_after_cutoff: bars.length - visible.length };
}

// ── S26-027 Resistance rejection cluster ──────────────────────────────────────

export interface RejectionAttempt {
  touch_date: string;
  available_date: string | null;
  outcome: "rejected" | "breakout_hold" | "pending" | "unavailable";
}

/** A rejection is counted only after its full confirmation horizon is observed. */
export function resistanceRejectionCluster(bars: readonly DailyBar[], options: {
  cutoff: string;
  resistance: number;
  touchTolerance: number;
  confirmationBars: number;
  minSpacing: number;
}): { status: "computed" | "unsupported"; reason?: string; attempts?: RejectionAttempt[]; rejection_count?: number; trend_context?: "up" | "down" | "flat" | "unknown" } {
  if (!Number.isFinite(options.resistance) || options.resistance <= 0 || !Number.isFinite(options.touchTolerance) || options.touchTolerance < 0
    || !Number.isInteger(options.confirmationBars) || options.confirmationBars < 1 || !Number.isInteger(options.minSpacing) || options.minSpacing < 1) {
    throw new RangeError("invalid resistance cluster settings");
  }
  const visible = visibleBars(bars, options.cutoff);
  if (visible.length < 2) return { status: "unsupported", reason: "insufficient history" };
  const attempts: RejectionAttempt[] = [];
  let lastTouch = -Infinity;
  for (let i = 0; i < visible.length; i++) {
    const item = visible[i];
    if (i - lastTouch < options.minSpacing || item.high === null || item.close === null
      || item.high < options.resistance * (1 - options.touchTolerance) || item.close >= options.resistance) continue;
    lastTouch = i;
    const after = visible.slice(i + 1, i + 1 + options.confirmationBars);
    const hasHeldBreakout = after.length >= options.confirmationBars && after.every((bar) => bar.close !== null && bar.close >= options.resistance);
    const outcome: RejectionAttempt["outcome"] = hasHeldBreakout ? "breakout_hold"
      : after.length < options.confirmationBars ? "pending"
        : after.some((bar) => bar.close === null) ? "unavailable" : "rejected";
    attempts.push({ touch_date: item.date, available_date: after.length === options.confirmationBars ? after.at(-1)!.date : null, outcome });
  }
  const closes = visible.slice(-Math.min(5, visible.length)).flatMap((item) => item.close === null ? [] : [item.close]);
  const trend_context = closes.length < 2 ? "unknown" : closes.at(-1)! > closes[0] ? "up" : closes.at(-1)! < closes[0] ? "down" : "flat";
  return { status: "computed", attempts, rejection_count: attempts.filter((item) => item.outcome === "rejected").length, trend_context };
}

// ── S26-028 Distribution-range exit ──────────────────────────────────────────

export interface DistributionExit {
  exit_date: string;
  support: number;
  resistance: number;
  range_duration: number;
  exit_buffer: number;
  retest_state: "retested" | "held" | "pending" | "unavailable";
  retest_date: string | null;
}

/** Requires a pre-existing horizontal range. A falling channel is rejected by two-sided support/resistance drift. */
export function distributionRangeExit(bars: readonly DailyBar[], options: {
  cutoff: string;
  rangeWindow: number;
  minDuration: number;
  maxResistanceDrift: number;
  exitBuffer: number;
  retestWindow: number;
}): { status: "computed" | "unsupported"; reason?: string; qualified_range?: boolean; exit?: DistributionExit | null } {
  if (![options.rangeWindow, options.minDuration, options.retestWindow].every((value) => Number.isInteger(value) && value >= 1)
    || options.rangeWindow < 8 || options.minDuration > options.rangeWindow
    || ![options.maxResistanceDrift, options.exitBuffer].every((value) => Number.isFinite(value) && value >= 0)) throw new RangeError("invalid distribution range settings");
  const visible = visibleBars(bars, options.cutoff);
  if (visible.length < options.rangeWindow + 1) return { status: "unsupported", reason: "insufficient history" };
  let sawQualifiedRange = false;
  for (let i = options.rangeWindow; i < visible.length; i++) {
    const history = visible.slice(i - options.rangeWindow, i);
    const current = visible[i];
    if (history.some((item) => item.high === null || item.low === null || item.close === null || item.low <= 0) || current.close === null) continue;
    const half = Math.floor(history.length / 2);
    const first = history.slice(0, half);
    const second = history.slice(half);
    const resistance = Math.max(...history.map((item) => item.high!));
    const support = Math.min(...history.map((item) => item.low!));
    const firstTop = Math.max(...first.map((item) => item.high!));
    const secondTop = Math.max(...second.map((item) => item.high!));
    const firstBottom = Math.min(...first.map((item) => item.low!));
    const secondBottom = Math.min(...second.map((item) => item.low!));
    const resistanceDrift = Math.abs(secondTop - firstTop) / firstTop;
    const supportDrift = Math.abs(secondBottom - firstBottom) / firstBottom;
    const qualified_range = options.rangeWindow >= options.minDuration
      && resistanceDrift <= options.maxResistanceDrift && supportDrift <= options.maxResistanceDrift;
    if (!qualified_range) continue;
    sawQualifiedRange = true;
    if (current.close >= support * (1 - options.exitBuffer)) continue;
    const after = visible.slice(i + 1, i + 1 + options.retestWindow);
    const retest = after.find((item) => item.close !== null && item.close >= support);
    const retest_state: DistributionExit["retest_state"] = retest ? "retested"
      : after.length < options.retestWindow ? "pending"
        : after.some((item) => item.close === null) ? "unavailable" : "held";
    return {
      status: "computed", qualified_range: true,
      exit: { exit_date: current.date, support, resistance, range_duration: history.length, exit_buffer: options.exitBuffer,
        retest_state, retest_date: retest?.date ?? null },
    };
  }
  return { status: "computed", qualified_range: sawQualifiedRange, exit: null };
}

