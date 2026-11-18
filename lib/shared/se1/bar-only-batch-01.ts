/**
 * S26-001/002/003/007/015/019. Deterministic helpers over supplied bars or supplied detector outcomes.
 * Thresholds are provisional inputs, not calibrated trading rules. No function calls a provider or infers missing data.
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

function barsAtCutoff(bars: readonly DailyBar[], cutoff: string): DailyBar[] {
  if (parseIso(cutoff) === null) throw new RangeError("cutoff must be a valid ISO date");
  for (const bar of bars) {
    if (parseIso(bar.date) === null) throw new RangeError(`invalid bar date: ${bar.date}`);
    for (const [key, value] of Object.entries(bar)) {
      if (key !== "date" && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        throw new RangeError(`invalid ${key} on ${bar.date}`);
      }
    }
  }
  return bars.filter((bar) => bar.date <= cutoff).slice().sort((a, b) => a.date.localeCompare(b.date));
}

// ── S26-001 Signal fragility ──────────────────────────────────────────────────

export interface DetectorEvaluation {
  score: number;
  action: string;
}

export type FragilityResult =
  | {
      status: "computed";
      detector_id: string;
      config_version: string;
      uncertainty_basis: string;
      scenario_count: number;
      stable_count: number;
      stable_fraction: number;
      failed_cases: string[];
      excluded_after_cutoff: number;
    }
  | { status: "unsupported"; reason: string };

/** One-factor-at-a-time ± bound stress. A percentage is returned only with a caller-declared uncertainty basis. */
export function signalFragility(
  bars: readonly DailyBar[],
  options: {
    cutoff: string;
    detector_id: string;
    config_version: string;
    uncertainty_basis: string;
    price_bound: number;
    volume_bound: number;
    score_tolerance: number;
    evaluate: (snapshot: readonly DailyBar[]) => DetectorEvaluation;
  },
): FragilityResult {
  const visible = barsAtCutoff(bars, options.cutoff);
  if (!options.detector_id.trim() || !options.config_version.trim() || !options.uncertainty_basis.trim()) {
    return { status: "unsupported", reason: "detector, config version and grounded uncertainty basis are required" };
  }
  if (![options.price_bound, options.volume_bound, options.score_tolerance].every(Number.isFinite)
    || options.price_bound < 0 || options.volume_bound < 0 || options.score_tolerance < 0) {
    throw new RangeError("bounds and score_tolerance must be finite and non-negative");
  }
  const baseline = options.evaluate(visible);
  if (!Number.isFinite(baseline.score) || !baseline.action.trim()) throw new RangeError("detector returned an invalid evaluation");
  const failed_cases: string[] = [];
  let scenario_count = 0;
  let stable_count = 0;
  const priceFields = ["open", "high", "low", "close"] as const;
  for (let i = 0; i < visible.length; i++) {
    for (const field of [...priceFields, "volume"] as const) {
      const bound = field === "volume" ? options.volume_bound : options.price_bound;
      const original = visible[i][field];
      if (original === null || bound === 0) continue;
      for (const sign of [-1, 1] as const) {
        const perturbedValue = original + sign * bound;
        if (perturbedValue < 0) continue;
        const scenario = visible.map((bar) => ({ ...bar }));
        scenario[i] = { ...scenario[i], [field]: perturbedValue };
        const evaluation = options.evaluate(scenario);
        if (!Number.isFinite(evaluation.score) || !evaluation.action.trim()) throw new RangeError("detector returned an invalid perturbed evaluation");
        scenario_count += 1;
        const stable = evaluation.action === baseline.action && Math.abs(evaluation.score - baseline.score) <= options.score_tolerance;
        if (stable) stable_count += 1;
        else failed_cases.push(`${visible[i].date}:${field}:${sign < 0 ? "minus" : "plus"}`);
      }
    }
  }
  if (scenario_count === 0) return { status: "unsupported", reason: "no usable non-zero perturbation scenarios" };
  return {
    status: "computed", detector_id: options.detector_id, config_version: options.config_version,
    uncertainty_basis: options.uncertainty_basis, scenario_count, stable_count,
    stable_fraction: stable_count / scenario_count, failed_cases,
    excluded_after_cutoff: bars.length - visible.length,
  };
}

// ── S26-002 Remove-one-detector ───────────────────────────────────────────────

export interface DetectorContribution {
  family: string;
  contribution: number;
}

export interface OmissionResult {
  family: string;
  score: number;
  below_threshold: boolean;
}

/** Sums the supplied score contributions and removes one whole family at a time; no independence is inferred. */
export function removeOneDetector(contributions: readonly DetectorContribution[], threshold: number): {
  baseline_score: number;
  threshold: number;
  omissions: OmissionResult[];
  interpretation: "family_contributions_are_not_independence_evidence";
} {
  if (!Number.isFinite(threshold)) throw new RangeError("threshold must be finite");
  if (contributions.some((item) => !item.family.trim() || !Number.isFinite(item.contribution))) throw new RangeError("contributions need a family and finite score");
  const families = [...new Set(contributions.map((item) => item.family))].sort();
  const baseline_score = contributions.reduce((sum, item) => sum + item.contribution, 0);
  return {
    baseline_score,
    threshold,
    omissions: families.map((family) => {
      const score = contributions.filter((item) => item.family !== family).reduce((sum, item) => sum + item.contribution, 0);
      return { family, score, below_threshold: score < threshold };
    }),
    interpretation: "family_contributions_are_not_independence_evidence",
  };
}

// ── S26-003 Horizon disagreement ──────────────────────────────────────────────

export type Direction = "up" | "down" | "flat";
export interface HorizonObservation {
  horizon: string;
  direction: Direction | null;
  expected: number;
  observed: number;
}

export interface HorizonState {
  horizon: string;
  state: "observed" | "missing";
  direction: Direction | null;
  expected: number;
  observed: number;
  coverage: number | null;
}

/** Missing horizons remain missing and never participate in a directional average or vote. */
export function horizonDisagreement(observations: readonly HorizonObservation[], requiredHorizons: readonly string[]): {
  horizons: HorizonState[];
  disagreement: boolean;
} {
  if (requiredHorizons.some((h) => !h.trim()) || new Set(requiredHorizons).size !== requiredHorizons.length) {
    throw new RangeError("required horizons must be unique non-empty labels");
  }
  const byHorizon = new Map<string, HorizonObservation>();
  for (const item of observations) {
    if (byHorizon.has(item.horizon)) throw new RangeError(`duplicate horizon: ${item.horizon}`);
    if (!Number.isInteger(item.expected) || item.expected < 1 || !Number.isInteger(item.observed) || item.observed < 0 || item.observed > item.expected) {
      throw new RangeError(`invalid coverage for horizon ${item.horizon}`);
    }
    byHorizon.set(item.horizon, item);
  }
  const horizons = requiredHorizons.map((horizon): HorizonState => {
    const item = byHorizon.get(horizon);
    if (!item || item.observed === 0 || item.direction === null) {
      return { horizon, state: "missing", direction: null, expected: item?.expected ?? 0, observed: item?.observed ?? 0, coverage: item ? item.observed / item.expected : null };
    }
    return { horizon, state: "observed", direction: item.direction, expected: item.expected, observed: item.observed, coverage: item.observed / item.expected };
  });
  const directions = new Set(horizons.flatMap((item) => item.state === "observed" ? [item.direction!] : []));
  return { horizons, disagreement: directions.size > 1 };
}

// ── S26-007 Baseline survival ─────────────────────────────────────────────────

export interface SurvivalWindow {
  id: string;
  kind: "chronological" | "randomized";
  sample_size: number;
  passed: boolean;
}

export interface SurvivalGroup {
  total: number;
  passed: number;
  failed: number;
  sample_size: number;
}

/** Reports every declared window and baseline; it never picks or promotes the best window. */
export function baselineSurvival(windows: readonly SurvivalWindow[]): {
  chronological: SurvivalGroup;
  randomized: SurvivalGroup;
  failed_windows: string[];
} {
  if (new Set(windows.map((item) => item.id)).size !== windows.length) throw new RangeError("window ids must be unique");
  if (windows.some((item) => !item.id.trim() || !Number.isInteger(item.sample_size) || item.sample_size < 1)) {
    throw new RangeError("each window needs an id and positive integer sample size");
  }
  const group = (kind: SurvivalWindow["kind"]): SurvivalGroup => {
    const selected = windows.filter((item) => item.kind === kind);
    const passed = selected.filter((item) => item.passed).length;
    return { total: selected.length, passed, failed: selected.length - passed, sample_size: selected.reduce((sum, item) => sum + item.sample_size, 0) };
  };
  return {
    chronological: group("chronological"), randomized: group("randomized"),
    failed_windows: windows.filter((item) => !item.passed).map((item) => item.id),
  };
}

// ── S26-015 Base width versus depth ───────────────────────────────────────────

export interface BaseWidthResult {
  status: "computed" | "unsupported";
  reason?: string;
  qualifies?: boolean;
  start_date?: string;
  end_date?: string;
  support?: number;
  support_drift?: number;
  first_depth?: number;
  second_depth?: number;
  support_touches?: number;
  touch_spacing?: number[];
  excluded_structural_breaks?: number;
}

function rangeDepth(bars: readonly DailyBar[]): number {
  const high = Math.max(...bars.map((item) => item.high!));
  const low = Math.min(...bars.map((item) => item.low!));
  return (high - low) / low;
}

/** Rolling range diagnostic. All bands and touch counts are provisional caller settings. */
export function baseWidthVersusDepth(bars: readonly DailyBar[], options: {
  cutoff: string;
  window: number;
  supportBand: number;
  maxSupportDrift: number;
  minTouches?: number;
  minTouchSpacing?: number;
  minDepthShrink?: number;
  breakBuffer?: number;
}): BaseWidthResult {
  if (!Number.isInteger(options.window) || options.window < 8) throw new RangeError("window must be at least 8 bars");
  const visible = barsAtCutoff(bars, options.cutoff);
  if (visible.length < options.window) return { status: "unsupported", reason: "insufficient history" };
  if (![options.supportBand, options.maxSupportDrift, options.minDepthShrink ?? 0.1, options.breakBuffer ?? 0].every(Number.isFinite)
    || options.supportBand < 0 || options.maxSupportDrift < 0 || (options.minDepthShrink ?? 0.1) < 0 || (options.breakBuffer ?? 0) < 0) {
    throw new RangeError("base thresholds must be finite and non-negative");
  }
  const span = visible.slice(-options.window);
  if (span.some((item) => item.high === null || item.low === null || item.close === null || item.low <= 0)) {
    return { status: "unsupported", reason: "missing or non-positive OHLC in window" };
  }
  const split = Math.floor(span.length / 2);
  const first = span.slice(0, split);
  const second = span.slice(split);
  const firstSupport = Math.min(...first.map((item) => item.low!));
  const secondSupport = Math.min(...second.map((item) => item.low!));
  const support = Math.min(firstSupport, secondSupport);
  const support_drift = Math.abs(secondSupport - firstSupport) / firstSupport;
  const band = support * options.supportBand;
  const touches = span.flatMap((item, i) => item.low! <= support + band ? [i] : []);
  const minTouches = options.minTouches ?? 2;
  const minTouchSpacing = options.minTouchSpacing ?? 2;
  const touch_spacing = touches.slice(1).map((index, i) => index - touches[i]);
  const spacingQualified = touch_spacing.length >= minTouches - 1 && touch_spacing.every((distance) => distance >= minTouchSpacing);
  const first_depth = rangeDepth(first);
  const second_depth = rangeDepth(second);
  const excluded_structural_breaks = second.filter((item) => item.close! < support * (1 - (options.breakBuffer ?? 0))).length;
  const qualifies = touches.length >= minTouches && spacingQualified
    && support_drift <= options.maxSupportDrift
    && second_depth <= first_depth * (1 - (options.minDepthShrink ?? 0.1))
    && excluded_structural_breaks === 0;
  return {
    status: "computed", qualifies, start_date: span[0].date, end_date: span.at(-1)!.date,
    support, support_drift, first_depth, second_depth, support_touches: touches.length, touch_spacing,
    excluded_structural_breaks,
  };
}

// ── S26-019 Relative-strength bottom lead ─────────────────────────────────────

export interface DatedClose {
  date: string;
  close: number | null;
}

export type LeadershipRolloverResult =
  | {
      status: "computed";
      ticker: string;
      benchmark: string;
      observations: number;
      raw_stock_return_pct: number;
      benchmark_return_pct: number;
      residual_return_pct: number;
      residual_slope_per_session: number;
      stock_below_long_average: boolean;
      benchmark_below_long_average: boolean;
      qualifies: boolean;
    }
  | { status: "unsupported"; reason: string };

/** Uses exact-date overlap supplied by the caller; benchmark choice and all lookbacks remain explicit. */
export function leadershipRollover(
  ticker: string,
  benchmark: string,
  stockCloses: readonly DatedClose[],
  benchmarkCloses: readonly DatedClose[],
  options: { cutoff: string; relativeWindow: number; longAverageWindow: number; minOverlap: number; minResidualSlope: number },
): LeadershipRolloverResult {
  if (!Number.isInteger(options.relativeWindow) || options.relativeWindow < 2
    || !Number.isInteger(options.longAverageWindow) || options.longAverageWindow < 2
    || !Number.isInteger(options.minOverlap) || options.minOverlap < 2
    || !Number.isFinite(options.minResidualSlope) || options.minResidualSlope < 0) {
    throw new RangeError("windows must be integers >= 2 and minResidualSlope non-negative");
  }
  const stock = new Map(stockCloses.filter((item) => item.date <= options.cutoff).map((item) => [item.date, item.close]));
  const bench = new Map(benchmarkCloses.filter((item) => item.date <= options.cutoff).map((item) => [item.date, item.close]));
  const aligned = [...stock.keys()].filter((date) => bench.has(date) && stock.get(date) !== null && bench.get(date) !== null)
    .sort().map((date) => ({ date, stock: stock.get(date)!, benchmark: bench.get(date)! }));
  const required = Math.max(options.relativeWindow, options.longAverageWindow);
  if (aligned.length < Math.max(options.minOverlap, required)) return { status: "unsupported", reason: "insufficient same-date usable overlap" };
  const tail = aligned.slice(-required);
  if (tail.some((item) => item.stock <= 0 || item.benchmark <= 0)) return { status: "unsupported", reason: "non-positive close in aligned window" };
  const rel = tail.slice(-options.relativeWindow);
  const first = rel[0];
  const last = rel.at(-1)!;
  const relativeValues = rel.map((item) => item.stock / item.benchmark);
  const meanX = (relativeValues.length - 1) / 2;
  const meanY = relativeValues.reduce((sum, value) => sum + value, 0) / relativeValues.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < relativeValues.length; i++) {
    numerator += (i - meanX) * (relativeValues[i] - meanY);
    denominator += (i - meanX) ** 2;
  }
  const residual_slope_per_session = numerator / denominator / relativeValues[0];
  const long = tail.slice(-options.longAverageWindow);
  const stockAverage = long.reduce((sum, item) => sum + item.stock, 0) / long.length;
  const benchmarkAverage = long.reduce((sum, item) => sum + item.benchmark, 0) / long.length;
  const raw_stock_return_pct = (last.stock / first.stock - 1) * 100;
  const benchmark_return_pct = (last.benchmark / first.benchmark - 1) * 100;
  const residual_return_pct = ((last.stock / first.stock) / (last.benchmark / first.benchmark) - 1) * 100;
  const stock_below_long_average = last.stock < stockAverage;
  const benchmark_below_long_average = last.benchmark < benchmarkAverage;
  return {
    status: "computed", ticker, benchmark, observations: aligned.length,
    raw_stock_return_pct, benchmark_return_pct, residual_return_pct, residual_slope_per_session,
    stock_below_long_average, benchmark_below_long_average,
    qualifies: residual_slope_per_session > options.minResidualSlope && stock_below_long_average && benchmark_below_long_average,
  };
}

