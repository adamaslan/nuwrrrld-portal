/**
 * S26-055/059/060/062/063/066. Pure bar and caller-supplied cross-sectional diagnostics.
 * Inputs, dates, cohort definitions and thresholds are explicit; missing observations are not imputed.
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

function trueRangeAt(bars: readonly DailyBar[], index: number): number | null {
  if (index < 1) return null;
  const current = bars[index];
  const prior = bars[index - 1].close;
  if (current.high === null || current.low === null || prior === null) return null;
  return Math.max(current.high - current.low, Math.abs(current.high - prior), Math.abs(current.low - prior));
}

function atrAt(bars: readonly DailyBar[], index: number, window: number): number | null {
  if (index < window) return null;
  const ranges: number[] = [];
  for (let i = index - window + 1; i <= index; i++) {
    const value = trueRangeAt(bars, i);
    if (value === null) return null;
    ranges.push(value);
  }
  return mean(ranges);
}

// ── S26-055 Failed volatility release ─────────────────────────────────────────

export interface FrozenPriceRange {
  startDate: string;
  endDate: string;
  high: number;
  low: number;
}

/** Uses only the range frozen before the declared squeeze exit; unresolved cases are right-censored at cutoff. */
export function failedVolatilityRelease(bars: readonly DailyBar[], options: {
  cutoff: string;
  releaseDate: string;
  frozenRange: FrozenPriceRange;
}): { status: "computed" | "unsupported"; reason?: string; state?: "failed" | "unresolved" | "unavailable";
  release_date?: string; reentry_date?: string | null; elapsed_bars?: number | null; frozen_range?: FrozenPriceRange } {
  const { frozenRange } = options;
  if (parseIso(options.releaseDate) === null || parseIso(frozenRange.startDate) === null || parseIso(frozenRange.endDate) === null
    || parseIso(options.cutoff) === null || frozenRange.startDate > frozenRange.endDate || frozenRange.endDate >= options.releaseDate
    || !Number.isFinite(frozenRange.high) || !Number.isFinite(frozenRange.low) || frozenRange.low >= frozenRange.high) {
    throw new RangeError("release and frozen range dates/bounds are invalid");
  }
  const series = visible(bars, options.cutoff);
  const releaseIndex = series.findIndex((bar) => bar.date === options.releaseDate);
  if (releaseIndex < 0) return { status: "unsupported", reason: "release date is not observed by cutoff" };
  const releaseClose = series[releaseIndex].close;
  if (releaseClose === null) return { status: "computed", state: "unavailable", release_date: options.releaseDate, reentry_date: null, elapsed_bars: null, frozen_range: frozenRange };
  if (releaseClose >= frozenRange.low && releaseClose <= frozenRange.high) return { status: "unsupported", reason: "declared release close did not exit the frozen range" };
  const after = series.slice(releaseIndex + 1);
  const reentry = after.find((bar) => bar.close !== null && bar.close >= frozenRange.low && bar.close <= frozenRange.high);
  return {
    status: "computed", state: reentry ? "failed" : after.some((bar) => bar.close === null) ? "unavailable" : "unresolved",
    release_date: options.releaseDate, reentry_date: reentry?.date ?? null,
    elapsed_bars: reentry ? series.indexOf(reentry) - releaseIndex : after.length,
    frozen_range: frozenRange,
  };
}

// ── S26-059 Post-shock volatility normalization ───────────────────────────────

/** A caller-supplied pre-shock ATR-percent band remains frozen for the full observation. */
export function postShockVolatilityNormalization(bars: readonly DailyBar[], options: {
  cutoff: string;
  shockDate: string;
  preShockBandThroughDate: string;
  atrWindow: number;
  preShockAtrPctBand: readonly [number, number];
}): { status: "computed" | "unsupported"; reason?: string; state?: "normalized" | "pending" | "unavailable";
  shock_date?: string; normalization_date?: string | null; pre_shock_band_through_date?: string;
  current_atr_pct?: number | null; price_change_pct?: number | null; price_drawdown_pct?: number | null; missing_atr_sessions?: number } {
  const [bandLow, bandHigh] = options.preShockAtrPctBand;
  if (parseIso(options.shockDate) === null || parseIso(options.preShockBandThroughDate) === null || options.preShockBandThroughDate >= options.shockDate
    || !Number.isInteger(options.atrWindow) || options.atrWindow < 2 || !Number.isFinite(bandLow) || !Number.isFinite(bandHigh) || bandLow < 0 || bandLow > bandHigh) {
    throw new RangeError("invalid shock, baseline or ATR settings");
  }
  const series = visible(bars, options.cutoff);
  const shockIndex = series.findIndex((bar) => bar.date === options.shockDate);
  if (shockIndex < 0) return { status: "unsupported", reason: "shock date is not observed by cutoff" };
  const shockClose = series[shockIndex].close;
  if (shockClose === null || shockClose <= 0) return { status: "unsupported", reason: "shock close is missing or non-positive" };
  let normalization_date: string | null = null;
  let current_atr_pct: number | null = null;
  let missing_atr_sessions = 0;
  for (let i = shockIndex + 1; i < series.length; i++) {
    const atr = atrAt(series, i, options.atrWindow);
    const close = series[i].close;
    if (atr === null || close === null || close <= 0) { missing_atr_sessions++; continue; }
    current_atr_pct = atr / close;
    if (current_atr_pct >= bandLow && current_atr_pct <= bandHigh) { normalization_date = series[i].date; break; }
  }
  const lastClose = series.at(-1)?.close ?? null;
  const lows = series.slice(shockIndex).flatMap((bar) => bar.low === null ? [] : [bar.low]);
  const price_change_pct = lastClose === null ? null : (lastClose / shockClose - 1) * 100;
  const price_drawdown_pct = lows.length ? (Math.min(...lows) / shockClose - 1) * 100 : null;
  return {
    status: "computed", state: normalization_date ? "normalized" : missing_atr_sessions ? "unavailable" : "pending",
    shock_date: options.shockDate, normalization_date, pre_shock_band_through_date: options.preShockBandThroughDate,
    current_atr_pct, price_change_pct, price_drawdown_pct, missing_atr_sessions,
  };
}

// ── S26-060 Cross-sectional volatility rank stability ─────────────────────────

export interface VolatilityMember {
  ticker: string;
  canonicalId: string;
  priorVolatility: number | null;
  currentVolatility: number | null;
  priorMember: boolean;
  currentMember: boolean;
  leveraged: boolean;
}

/** Rank turnover uses the identical eligible set at both cutoffs; leveraged instruments and churn are excluded. */
export function crossSectionalVolatilityRankStability(members: readonly VolatilityMember[]): {
  stable_intersection: number;
  mean_absolute_rank_change: number | null;
  rank_changes: { ticker: string; prior_rank: number; current_rank: number }[];
  exclusions: { membership_changed: number; leveraged: number; missing_volatility: number; duplicate_canonical: number };
} {
  if (new Set(members.map((item) => item.ticker)).size !== members.length) throw new RangeError("tickers must be unique");
  const canonicalCounts = new Map<string, number>();
  for (const item of members) canonicalCounts.set(item.canonicalId, (canonicalCounts.get(item.canonicalId) ?? 0) + 1);
  const duplicateIds = new Set([...canonicalCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const changed = members.filter((item) => item.priorMember !== item.currentMember).length;
  const leveraged = members.filter((item) => item.leveraged && item.priorMember && item.currentMember).length;
  const duplicate_canonical = members.filter((item) => duplicateIds.has(item.canonicalId) && item.priorMember && item.currentMember).length;
  const missing_volatility = members.filter((item) => item.priorMember && item.currentMember && !item.leveraged
    && !duplicateIds.has(item.canonicalId) && (item.priorVolatility === null || item.currentVolatility === null)).length;
  const eligible = members.filter((item) => item.priorMember && item.currentMember && !item.leveraged && !duplicateIds.has(item.canonicalId)
    && item.priorVolatility !== null && item.currentVolatility !== null);
  if (eligible.some((item) => item.priorVolatility! < 0 || item.currentVolatility! < 0
    || !Number.isFinite(item.priorVolatility) || !Number.isFinite(item.currentVolatility))) throw new RangeError("volatility values must be finite and non-negative");
  const rank = (field: "priorVolatility" | "currentVolatility") => new Map([...eligible]
    .sort((a, b) => b[field]! - a[field]! || a.ticker.localeCompare(b.ticker)).map((item, index) => [item.ticker, index + 1]));
  const prior = rank("priorVolatility");
  const current = rank("currentVolatility");
  const rank_changes = eligible.map((item) => ({ ticker: item.ticker, prior_rank: prior.get(item.ticker)!, current_rank: current.get(item.ticker)! }));
  const mean_absolute_rank_change = rank_changes.length ? mean(rank_changes.map((item) => Math.abs(item.prior_rank - item.current_rank))) : null;
  return { stable_intersection: eligible.length, mean_absolute_rank_change, rank_changes, exclusions: { membership_changed: changed, leveraged, missing_volatility, duplicate_canonical } };
}

// ── S26-062 Volatility-estimator disagreement ────────────────────────────────

/** Measures share percent units but retain their separate definitions and sample counts. */
export function volatilityEstimatorDisagreement(bars: readonly DailyBar[], options: { cutoff: string; window: number }): {
  status: "computed" | "unsupported"; reason?: string;
  measures?: { close_return_dispersion_pct: number | null; mean_true_range_pct: number | null; mean_high_low_range_pct: number | null };
  sample_counts?: { close_returns: number; true_ranges: number; high_low_ranges: number };
  input_gaps?: { missing_closes: number; missing_true_range_inputs: number; missing_high_low: number };
  units?: "percent";
} {
  if (!Number.isInteger(options.window) || options.window < 2) throw new RangeError("window must be an integer of at least 2");
  const series = visible(bars, options.cutoff);
  if (series.length < options.window + 1) return { status: "unsupported", reason: "insufficient history" };
  const span = series.slice(-options.window - 1);
  const returns: number[] = [];
  const trs: number[] = [];
  const ranges: number[] = [];
  let missing_closes = 0;
  let missing_true_range_inputs = 0;
  let missing_high_low = 0;
  for (let i = 1; i < span.length; i++) {
    const prior = span[i - 1].close;
    const current = span[i];
    if (prior === null || current.close === null || prior <= 0) missing_closes++;
    else returns.push(current.close / prior - 1);
    const tr = trueRangeAt(span, i);
    if (tr === null || current.close === null || current.close <= 0) missing_true_range_inputs++;
    else trs.push(tr / current.close * 100);
    if (current.high === null || current.low === null || current.close === null || current.close <= 0) missing_high_low++;
    else ranges.push((current.high - current.low) / current.close * 100);
  }
  if (!returns.length && !trs.length && !ranges.length) return { status: "unsupported", reason: "no comparable estimator samples" };
  const meanReturn = returns.length ? mean(returns) : 0;
  const close_return_dispersion_pct = returns.length ? Math.sqrt(mean(returns.map((value) => (value - meanReturn) ** 2))) * 100 : null;
  return {
    status: "computed",
    measures: { close_return_dispersion_pct, mean_true_range_pct: trs.length ? mean(trs) : null, mean_high_low_range_pct: ranges.length ? mean(ranges) : null },
    sample_counts: { close_returns: returns.length, true_ranges: trs.length, high_low_ranges: ranges.length },
    input_gaps: { missing_closes, missing_true_range_inputs, missing_high_low }, units: "percent",
  };
}

// ── S26-063 Breadth thrust versus coverage jump ────────────────────────────────

export interface BreadthMember {
  ticker: string;
  priorMember: boolean;
  currentMember: boolean;
  priorAbove: boolean | null;
  currentAbove: boolean | null;
}

/** Decomposes whole-universe change from breadth movement on a frozen common intersection. */
export function breadthThrustCoverage(members: readonly BreadthMember[]): {
  fixed_intersection: number;
  fixed_intersection_delta: number | null;
  prior_breadth: number | null;
  current_breadth: number | null;
  total_breadth_delta: number | null;
  membership_contribution: number | null;
  exclusions: { membership_changed: number; missing_prior: number; missing_current: number };
} {
  if (new Set(members.map((item) => item.ticker)).size !== members.length) throw new RangeError("tickers must be unique");
  const changed = members.filter((item) => item.priorMember !== item.currentMember).length;
  const missing_prior = members.filter((item) => item.priorMember && item.priorAbove === null).length;
  const missing_current = members.filter((item) => item.currentMember && item.currentAbove === null).length;
  const common = members.filter((item) => item.priorMember && item.currentMember && item.priorAbove !== null && item.currentAbove !== null);
  const priorEligible = members.filter((item) => item.priorMember && item.priorAbove !== null);
  const currentEligible = members.filter((item) => item.currentMember && item.currentAbove !== null);
  const fixed_intersection_delta = common.length ? mean(common.map((item) => Number(item.currentAbove) - Number(item.priorAbove))) : null;
  const prior_breadth = priorEligible.length ? mean(priorEligible.map((item) => Number(item.priorAbove))) : null;
  const current_breadth = currentEligible.length ? mean(currentEligible.map((item) => Number(item.currentAbove))) : null;
  const total_breadth_delta = prior_breadth === null || current_breadth === null ? null : current_breadth - prior_breadth;
  return {
    fixed_intersection: common.length, fixed_intersection_delta, prior_breadth, current_breadth, total_breadth_delta,
    membership_contribution: total_breadth_delta === null || fixed_intersection_delta === null ? null : total_breadth_delta - fixed_intersection_delta,
    exclusions: { membership_changed: changed, missing_prior, missing_current },
  };
}

// ── S26-066 Index strength with narrowing participation ───────────────────────

export interface IndexBreadthMember {
  ticker: string;
  sector: string | null;
  priorMember: boolean;
  currentMember: boolean;
  priorAboveAverage: boolean | null;
  currentAboveAverage: boolean | null;
  currentRank: number | null;
}

/** Benchmark price, common-member breadth and sector concentration are reported as correlated components. */
export function indexStrengthWithNarrowingParticipation(indexBars: readonly DailyBar[], members: readonly IndexBreadthMember[], options: {
  cutoff: string;
  indexWindow: number;
  nearHighRatio: number;
  topN: number;
}): { status: "computed" | "unsupported"; reason?: string; benchmark_near_high?: boolean; benchmark_distance_pct?: number;
  breadth_delta?: number | null; common_members?: number; top_sector_concentration?: number | null;
  unclassified_top_members?: number; components_are_correlated?: true } {
  if (!Number.isInteger(options.indexWindow) || options.indexWindow < 2 || !Number.isFinite(options.nearHighRatio) || options.nearHighRatio <= 0 || options.nearHighRatio > 1
    || !Number.isInteger(options.topN) || options.topN < 1) throw new RangeError("invalid index or cohort settings");
  const index = visible(indexBars, options.cutoff);
  if (index.length < options.indexWindow) return { status: "unsupported", reason: "insufficient benchmark history" };
  const tail = index.slice(-options.indexWindow);
  if (tail.some((bar) => bar.close === null || bar.close <= 0)) return { status: "unsupported", reason: "missing benchmark close" };
  if (new Set(members.map((item) => item.ticker)).size !== members.length) throw new RangeError("member tickers must be unique");
  const common = members.filter((item) => item.priorMember && item.currentMember && item.priorAboveAverage !== null && item.currentAboveAverage !== null);
  const breadth_delta = common.length ? mean(common.map((item) => Number(item.currentAboveAverage) - Number(item.priorAboveAverage))) : null;
  const ranked = members.filter((item) => item.currentMember && item.currentRank !== null && Number.isInteger(item.currentRank) && item.currentRank > 0)
    .slice().sort((a, b) => a.currentRank! - b.currentRank! || a.ticker.localeCompare(b.ticker)).slice(0, options.topN);
  const sectors = new Map<string, number>();
  let unclassified_top_members = 0;
  for (const item of ranked) {
    if (item.sector === null || !item.sector.trim()) unclassified_top_members++;
    else sectors.set(item.sector, (sectors.get(item.sector) ?? 0) + 1);
  }
  const classified = [...sectors.values()].reduce((sum, count) => sum + count, 0);
  const top_sector_concentration = classified ? [...sectors.values()].reduce((sum, count) => sum + (count / classified) ** 2, 0) : null;
  const high = Math.max(...tail.map((bar) => bar.close!));
  const close = tail.at(-1)!.close!;
  return {
    status: "computed", benchmark_near_high: close / high >= options.nearHighRatio,
    benchmark_distance_pct: (close / high - 1) * 100, breadth_delta, common_members: common.length,
    top_sector_concentration, unclassified_top_members, components_are_correlated: true,
  };
}

