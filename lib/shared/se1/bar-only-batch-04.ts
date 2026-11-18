/**
 * S26-037/038/039/040/053/054. Causal bar-only diagnostics. Thresholds are caller-declared and provisional.
 * No missing values are interpolated, and no result is a forecast or trade instruction.
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

function visible(bars: readonly DailyBar[], cutoff: string): DailyBar[] {
  if (parseIso(cutoff) === null) throw new RangeError("cutoff must be a valid ISO date");
  for (const bar of bars) {
    if (parseIso(bar.date) === null) throw new RangeError(`invalid bar date: ${bar.date}`);
    for (const [field, value] of Object.entries(bar)) {
      if (field !== "date" && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new RangeError(`invalid ${field} on ${bar.date}`);
    }
  }
  return bars.filter((bar) => bar.date <= cutoff).slice().sort((a, b) => a.date.localeCompare(b.date));
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(bars: readonly DailyBar[], index: number, window: number): number | null {
  if (index + 1 < window) return null;
  const closes = bars.slice(index - window + 1, index + 1).map((bar) => bar.close);
  return closes.some((close) => close === null) ? null : mean(closes as number[]);
}

function atrAt(bars: readonly DailyBar[], index: number, window: number): number | null {
  if (index < window) return null;
  const ranges: number[] = [];
  for (let i = index - window + 1; i <= index; i++) {
    const current = bars[i];
    const prior = bars[i - 1].close;
    if (current.high === null || current.low === null || prior === null) return null;
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - prior), Math.abs(current.low - prior)));
  }
  return mean(ranges);
}

function confirmedLowIndices(bars: readonly DailyBar[], pivotK: number): number[] {
  const pivots: number[] = [];
  for (let i = pivotK; i + pivotK < bars.length; i++) {
    const close = bars[i].close;
    const neighbors = bars.slice(i - pivotK, i + pivotK + 1).filter((_, offset) => offset !== pivotK);
    if (close !== null && neighbors.every((bar) => bar.close !== null && bar.close > close)) pivots.push(i);
  }
  return pivots;
}

// ── S26-037 Pullback depth consistency ────────────────────────────────────────

export interface PullbackDepth {
  pivot_date: string;
  available_date: string;
  prior_peak_date: string;
  peak_close: number;
  low_close: number;
  depth_pct: number;
  depth_atr: number | null;
}

/** Percentage damage and ATR-scaled depth are reported independently using a frozen strict-pivot definition. */
export function pullbackDepthConsistency(bars: readonly DailyBar[], options: { cutoff: string; pivotK: number; atrWindow: number }): {
  status: "computed" | "unsupported"; reason?: string; pivot_method?: string; pullbacks?: PullbackDepth[];
  comparison?: { percentage_depth_expanding: boolean; atr_depth_expanding: boolean | null; intact_higher_highs: boolean };
} {
  if (!Number.isInteger(options.pivotK) || options.pivotK < 1 || !Number.isInteger(options.atrWindow) || options.atrWindow < 2) throw new RangeError("invalid pivot or ATR windows");
  const series = visible(bars, options.cutoff);
  const pivots = confirmedLowIndices(series, options.pivotK);
  if (pivots.length < 2) return { status: "unsupported", reason: "fewer than two confirmed pullbacks" };
  const pullbacks: PullbackDepth[] = [];
  for (let p = 0; p < pivots.length; p++) {
    const lowIndex = pivots[p];
    const start = p === 0 ? 0 : pivots[p - 1];
    const segment = series.slice(start, lowIndex + 1);
    if (segment.some((bar) => bar.close === null) || series[lowIndex].close === null) continue;
    const peakClose = Math.max(...segment.map((bar) => bar.close!));
    const peakOffset = segment.findIndex((bar) => bar.close === peakClose);
    const peakIndex = start + peakOffset;
    if (peakClose <= series[lowIndex].close!) continue;
    const atr = atrAt(series, lowIndex, options.atrWindow);
    const depth = peakClose - series[lowIndex].close!;
    pullbacks.push({
      pivot_date: series[lowIndex].date,
      available_date: series[lowIndex + options.pivotK].date,
      prior_peak_date: series[peakIndex].date,
      peak_close: peakClose,
      low_close: series[lowIndex].close!,
      depth_pct: depth / peakClose * 100,
      depth_atr: atr !== null && atr > 0 ? depth / atr : null,
    });
  }
  if (pullbacks.length < 2) return { status: "unsupported", reason: "fewer than two comparable pullbacks" };
  const previous = pullbacks.at(-2)!;
  const current = pullbacks.at(-1)!;
  const priorPeaks = pullbacks.slice(0, -1).map((item) => item.peak_close);
  const intact_higher_highs = current.peak_close > Math.max(...priorPeaks);
  return {
    status: "computed", pivot_method: `strict close pivot, k=${options.pivotK}`,
    pullbacks,
    comparison: {
      percentage_depth_expanding: current.depth_pct > previous.depth_pct,
      atr_depth_expanding: current.depth_atr === null || previous.depth_atr === null ? null : current.depth_atr > previous.depth_atr,
      intact_higher_highs,
    },
  };
}

// ── S26-038 Close-location persistence around support ─────────────────────────

export type SupportLocation = "above" | "inside" | "below" | "missing";

/** Counts close locations around a declared fixed-width moving-average band; daily closes only. */
export function closeLocationAroundSupport(bars: readonly DailyBar[], options: { cutoff: string; movingAverageWindow: number; bandPct: number }): {
  status: "computed" | "unsupported"; reason?: string; band_pct?: number; counts?: Record<SupportLocation, number>; transitions?: number; locations?: { date: string; location: SupportLocation }[];
} {
  if (!Number.isInteger(options.movingAverageWindow) || options.movingAverageWindow < 2 || !Number.isFinite(options.bandPct) || options.bandPct < 0) throw new RangeError("invalid support band settings");
  const series = visible(bars, options.cutoff);
  if (series.length < options.movingAverageWindow) return { status: "unsupported", reason: "insufficient moving-average history" };
  const counts: Record<SupportLocation, number> = { above: 0, inside: 0, below: 0, missing: 0 };
  const locations: { date: string; location: SupportLocation }[] = [];
  for (let i = 0; i < series.length; i++) {
    if (i + 1 < options.movingAverageWindow) continue;
    const close = series[i].close;
    const average = sma(series, i, options.movingAverageWindow);
    let location: SupportLocation;
    if (close === null || average === null) location = "missing";
    else if (close > average * (1 + options.bandPct)) location = "above";
    else if (close < average * (1 - options.bandPct)) location = "below";
    else location = "inside";
    counts[location] += 1;
    locations.push({ date: series[i].date, location });
  }
  let transitions = 0;
  for (let i = 1; i < locations.length; i++) {
    if (locations[i - 1].location !== "missing" && locations[i].location !== "missing" && locations[i - 1].location !== locations[i].location) transitions++;
  }
  return { status: "computed", band_pct: options.bandPct, counts, transitions, locations };
}

// ── S26-039 Long-trend slope curvature ────────────────────────────────────────

function linearSlope(values: readonly number[]): number {
  const meanX = (values.length - 1) / 2;
  const meanY = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < values.length; i++) {
    numerator += (i - meanX) * (values[i] - meanY);
    denominator += (i - meanX) ** 2;
  }
  return numerator / denominator;
}

/** Two causal linear regressions on adjacent rolling windows; overlap and units are explicit. */
export function longTrendSlopeCurvature(bars: readonly DailyBar[], options: { cutoff: string; window: number; nearZeroSlope: number }): {
  status: "computed" | "unsupported"; reason?: string; current_slope?: number; prior_slope?: number; acceleration?: number;
  unit?: "price_per_bar"; overlap_bars?: number; uncertain_near_zero?: boolean; current_sign?: "positive" | "negative" | "zero";
} {
  if (!Number.isInteger(options.window) || options.window < 3 || !Number.isFinite(options.nearZeroSlope) || options.nearZeroSlope < 0) throw new RangeError("invalid slope settings");
  const series = visible(bars, options.cutoff);
  if (series.length < options.window + 1) return { status: "unsupported", reason: "insufficient history for adjacent slopes" };
  const currentValues = series.slice(-options.window).map((bar) => bar.close);
  const priorValues = series.slice(-options.window - 1, -1).map((bar) => bar.close);
  if ([...currentValues, ...priorValues].some((close) => close === null)) return { status: "unsupported", reason: "missing close in slope windows" };
  const current_slope = linearSlope(currentValues as number[]);
  const prior_slope = linearSlope(priorValues as number[]);
  return {
    status: "computed", current_slope, prior_slope, acceleration: current_slope - prior_slope,
    unit: "price_per_bar", overlap_bars: options.window - 1,
    uncertain_near_zero: Math.abs(current_slope) <= options.nearZeroSlope || Math.abs(prior_slope) <= options.nearZeroSlope,
    current_sign: current_slope > 0 ? "positive" : current_slope < 0 ? "negative" : "zero",
  };
}

// ── S26-040 Momentum reset without structure break ────────────────────────────

export type MomentumResetState = "restarted" | "broken_support" | "pending" | "unavailable";

/** Uses a declared support and caller-labeled trend context; emits a restart only after the momentum threshold is crossed. */
export function momentumResetWithoutStructureBreak(bars: readonly DailyBar[], options: {
  cutoff: string;
  momentumWindow: number;
  support: number;
  resetMax: number;
  restartMin: number;
  trendContext: "up" | "down" | "unknown";
}): {
  status: "computed" | "unsupported"; reason?: string; state?: MomentumResetState; reset_date?: string | null;
  restart_date?: string | null; support_survived?: boolean | null; trend_context?: "up" | "down" | "unknown"; eligible?: boolean;
} {
  if (!Number.isInteger(options.momentumWindow) || options.momentumWindow < 1 || !Number.isFinite(options.support) || options.support <= 0
    || !Number.isFinite(options.resetMax) || !Number.isFinite(options.restartMin) || options.restartMin <= options.resetMax) throw new RangeError("invalid momentum reset settings");
  const series = visible(bars, options.cutoff);
  if (series.length < options.momentumWindow + 1) return { status: "unsupported", reason: "insufficient momentum history" };
  let resetIndex = -1;
  for (let i = options.momentumWindow; i < series.length; i++) {
    const close = series[i].close;
    const prior = series[i - options.momentumWindow].close;
    if (close === null || prior === null || prior === 0) continue;
    if (close / prior - 1 <= options.resetMax) { resetIndex = i; break; }
  }
  if (resetIndex < 0) return { status: "computed", state: "pending", reset_date: null, restart_date: null, support_survived: null, trend_context: options.trendContext, eligible: false };
  let resetState: MomentumResetState = "pending";
  let restartIndex: number | null = null;
  let support_survived: boolean | null = true;
  for (let i = resetIndex; i < series.length; i++) {
    const bar = series[i];
    if (bar.close === null || bar.low === null) { support_survived = null; resetState = "unavailable"; break; }
    if (bar.low < options.support) { support_survived = false; resetState = "broken_support"; break; }
    if (i >= resetIndex + options.momentumWindow) {
      const prior = series[i - options.momentumWindow].close;
      if (prior === null || prior === 0) { support_survived = null; resetState = "unavailable"; break; }
      if (bar.close / prior - 1 >= options.restartMin) { restartIndex = i; resetState = "restarted"; break; }
    }
  }
  return {
    status: "computed", state: resetState, reset_date: series[resetIndex].date,
    restart_date: restartIndex === null ? null : series[restartIndex].date,
    support_survived, trend_context: options.trendContext,
    eligible: resetState === "restarted" && support_survived === true && options.trendContext === "up",
  };
}

// ── S26-053 Compression-duration percentile ───────────────────────────────────

export type CompressionDurationResult =
  | { status: "computed"; current_run: number; completed_run_lengths: number[]; sample_size: number; percentile: number }
  | { status: "unavailable"; reason: string; current_run: number; completed_run_lengths: number[]; sample_size: number };

/** The unfinished current run is excluded from the historical baseline. */
export function compressionDurationPercentile(bars: readonly DailyBar[], options: { cutoff: string; compressionWidth: number; minCompletedRuns: number }): CompressionDurationResult {
  if (!Number.isFinite(options.compressionWidth) || options.compressionWidth <= 0 || !Number.isInteger(options.minCompletedRuns) || options.minCompletedRuns < 1) throw new RangeError("invalid compression settings");
  const series = visible(bars, options.cutoff);
  if (series.length < 2) return { status: "unavailable", reason: "insufficient history", current_run: 0, completed_run_lengths: [], sample_size: 0 };
  const compressed = series.map((bar) => bar.close !== null && bar.close > 0 && bar.high !== null && bar.low !== null
    ? (bar.high - bar.low) / bar.close <= options.compressionWidth : null);
  if (compressed.at(-1) === null) return { status: "unavailable", reason: "missing current range", current_run: 0, completed_run_lengths: [], sample_size: 0 };
  let start = compressed.length - 1;
  while (start > 0 && compressed[start - 1] === true) start--;
  if (compressed[start] !== true) return { status: "computed", current_run: 0, completed_run_lengths: [], sample_size: 0, percentile: 0 };
  const current_run = compressed.length - start;
  const completed_run_lengths: number[] = [];
  let priorRun = 0;
  for (let i = 0; i < start; i++) {
    if (compressed[i] === true) priorRun++;
    else if (compressed[i] === false && priorRun > 0) { completed_run_lengths.push(priorRun); priorRun = 0; }
    else if (compressed[i] === null) priorRun = 0;
  }
  const sample_size = completed_run_lengths.length;
  if (sample_size < options.minCompletedRuns) return { status: "unavailable", reason: "too few prior completed compression runs", current_run, completed_run_lengths, sample_size };
  const percentile = completed_run_lengths.filter((length) => length <= current_run).length / sample_size;
  return { status: "computed", current_run, completed_run_lengths, sample_size, percentile };
}

// ── S26-054 Squeeze-release direction ambiguity ───────────────────────────────

export type SqueezeReleaseState = "no_expansion" | "upward_exit" | "downward_exit" | "ambiguous_inside";

/** Range bandwidth expansion is non-directional unless the current close exits the previously observed range. */
export function squeezeReleaseAmbiguity(bars: readonly DailyBar[], options: { cutoff: string; bandwidthWindow: number; minimumExpansion: number }): {
  status: "computed" | "unsupported"; reason?: string; state?: SqueezeReleaseState; bandwidth_expansion?: number;
  prior_range?: { high: number; low: number }; close?: number;
} {
  if (!Number.isInteger(options.bandwidthWindow) || options.bandwidthWindow < 2 || !Number.isFinite(options.minimumExpansion) || options.minimumExpansion <= 1) throw new RangeError("invalid bandwidth settings");
  const series = visible(bars, options.cutoff);
  if (series.length < options.bandwidthWindow * 2) return { status: "unsupported", reason: "insufficient adjacent bandwidth windows" };
  const prior = series.slice(-2 * options.bandwidthWindow, -options.bandwidthWindow);
  const current = series.slice(-options.bandwidthWindow);
  if ([...prior, ...current].some((bar) => bar.close === null || bar.close <= 0 || bar.high === null || bar.low === null)) return { status: "unsupported", reason: "missing range data in bandwidth window" };
  const bandwidth = (window: readonly DailyBar[]) => mean(window.map((bar) => (bar.high! - bar.low!) / bar.close!));
  const priorBandwidth = bandwidth(prior);
  const currentBandwidth = bandwidth(current);
  if (priorBandwidth === 0) return { status: "unsupported", reason: "zero prior bandwidth" };
  const bandwidth_expansion = currentBandwidth / priorBandwidth;
  const prior_range = { high: Math.max(...prior.map((bar) => bar.high!)), low: Math.min(...prior.map((bar) => bar.low!)) };
  const close = current.at(-1)!.close!;
  const state: SqueezeReleaseState = bandwidth_expansion < options.minimumExpansion ? "no_expansion"
    : close > prior_range.high ? "upward_exit"
      : close < prior_range.low ? "downward_exit" : "ambiguous_inside";
  return { status: "computed", state, bandwidth_expansion, prior_range, close };
}

