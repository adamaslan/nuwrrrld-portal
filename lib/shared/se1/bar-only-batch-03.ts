/**
 * S26-029/030/031/033/034/036. Deterministic bar-based diagnostics with explicit caller inputs.
 * Thresholds and cohort definitions are provisional. Missing observations remain missing; these scans do not predict returns.
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
  const cutoffTime = parseIso(cutoff);
  if (cutoffTime === null) throw new RangeError("cutoff must be a valid ISO date");
  const seen = new Set<number>();
  const dated = bars.map(bar => {
    const timestamp = parseIso(bar.date);
    if (timestamp === null) throw new RangeError(`invalid bar date: ${bar.date}`);
    if (seen.has(timestamp)) throw new RangeError(`duplicate bar date: ${bar.date}`);
    seen.add(timestamp);
    return {bar, timestamp};
  });
  const observed = dated.filter(item => item.timestamp <= cutoffTime).sort((a, b) => a.timestamp - b.timestamp).map(item => item.bar);
  for (const bar of observed) {
    for (const [field, value] of Object.entries(bar)) {
      if (field !== "date" && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new RangeError(`invalid ${field} on ${bar.date}`);
    }
  }
  return observed;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function smaAt(bars: readonly DailyBar[], index: number, window: number): number | null {
  if (index + 1 < window) return null;
  const values = bars.slice(index - window + 1, index + 1).map((item) => item.close);
  if (values.some((value) => value === null)) return null;
  return mean(values as number[]);
}

function datedVisible<T extends { date: string }>(rows: readonly T[], cutoff: string): T[] {
  const end = parseIso(cutoff);
  if (end === null) throw new RangeError("cutoff must be a valid ISO date");
  const seen = new Set<number>();
  return rows.map(row => {
    const time = parseIso(row.date);
    if (time === null) throw new RangeError("invalid input date");
    if (seen.has(time)) throw new RangeError("dates must be unique by instant");
    seen.add(time);
    return { row, time };
  }).filter(item => item.time <= end).sort((a, b) => a.time - b.time).map(item => item.row);
}

// ── S26-029 Defensive-sector relative rotation ────────────────────────────────

export interface SectorBasketMember {
  ticker: string;
  category: "defensive" | "cyclical";
  weight: number;
  basis: "total_return" | "price_return";
  bars: readonly { date: string; close: number | null }[];
}

/** Uses only predeclared ETF baskets, weights, common dates and the explicitly declared return basis. */
export function defensiveSectorRotation(members: readonly SectorBasketMember[], indexBars: readonly { date: string; close: number | null }[], options: {
  cutoff: string;
  indexWindow: number;
  nearHighRatio: number;
}): { status: "computed" | "unsupported"; reason?: string; broad_index_near_high?: boolean; spread_pct?: number | null; defensive_return_pct?: number | null; cyclical_return_pct?: number | null; declared_members?: string[]; missing_legs?: string[]; basis?: "total_return" } {
  if (!Number.isInteger(options.indexWindow) || options.indexWindow < 2 || !Number.isFinite(options.nearHighRatio)
    || options.nearHighRatio <= 0 || options.nearHighRatio > 1) throw new RangeError("invalid index window or near-high ratio");
  if (members.some((item) => item.basis !== "total_return")) return { status: "unsupported", reason: "all ETF legs must declare a total-return basis" };
  if (members.some((item) => !item.ticker.trim() || !Number.isFinite(item.weight) || item.weight <= 0)) throw new RangeError("basket members require a ticker and positive weight");
  const tickers = members.map((item) => item.ticker);
  if (new Set(tickers).size !== tickers.length) throw new RangeError("basket tickers must be unique");
  for (const category of ["defensive", "cyclical"] as const) {
    const total = members.filter((item) => item.category === category).reduce((sum, item) => sum + item.weight, 0);
    if (Math.abs(total - 1) > 1e-8) return { status: "unsupported", reason: `${category} basket weights must sum to one` };
  }
  const index = datedVisible(indexBars, options.cutoff);
  if (index.length < options.indexWindow) return { status: "unsupported", reason: "insufficient broad-index history" };
  const indexTail = index.slice(-options.indexWindow);
  if (indexTail.some((item) => item.close === null || !Number.isFinite(item.close) || item.close <= 0)) return { status: "unsupported", reason: "missing broad-index close in window" };
  const indexHigh = Math.max(...indexTail.map((item) => item.close!));
  const broad_index_near_high = indexTail.at(-1)!.close! / indexHigh >= options.nearHighRatio;
  const firstDate = indexTail[0].date;
  const lastDate = indexTail.at(-1)!.date;
  const missing_legs: string[] = [];
  const returns = new Map<string, number>();
  for (const member of members) {
    const series = new Map(datedVisible(member.bars, options.cutoff).map((item) => [parseIso(item.date), item.close]));
    const first = series.get(parseIso(firstDate));
    const last = series.get(parseIso(lastDate));
    if (first === undefined || last === undefined || first === null || last === null || !Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) {
      missing_legs.push(member.ticker);
      continue;
    }
    returns.set(member.ticker, last / first - 1);
  }
  if (missing_legs.length > 0) return { status: "computed", broad_index_near_high, spread_pct: null, defensive_return_pct: null, cyclical_return_pct: null, declared_members: tickers, missing_legs, basis: "total_return" };
  const basketReturn = (category: SectorBasketMember["category"]) => members.filter((item) => item.category === category)
    .reduce((sum, item) => sum + item.weight * returns.get(item.ticker)!, 0);
  const defensive_return_pct = basketReturn("defensive") * 100;
  const cyclical_return_pct = basketReturn("cyclical") * 100;
  return {
    status: "computed", broad_index_near_high, defensive_return_pct, cyclical_return_pct,
    spread_pct: defensive_return_pct - cyclical_return_pct, declared_members: tickers, missing_legs, basis: "total_return",
  };
}

// ── S26-030 Bearish oscillator-price disagreement age ─────────────────────────

export interface OscillatorPoint {
  date: string;
  price: number | null;
  oscillator: number | null;
}

export interface DisagreementEvent {
  prior_high_date: string;
  higher_high_date: string;
  available_date: string;
  age: number;
  state: "resolved" | "pending" | "failed";
}

/** Strict confirmed price pivots; a rising price with a non-rising oscillator stays contrary/pending until resolved. */
export function horizonDisagreementAge(points: readonly OscillatorPoint[], options: { cutoff: string; pivotK: number; weaknessBuffer: number }): {
  status: "computed" | "unsupported"; reason?: string; divergences?: DisagreementEvent[];
} {
  if (!Number.isInteger(options.pivotK) || options.pivotK < 1 || !Number.isFinite(options.weaknessBuffer) || options.weaknessBuffer < 0) throw new RangeError("invalid pivot or weakness settings");
  if (parseIso(options.cutoff) === null) throw new RangeError("cutoff must be a valid ISO date");
  if (points.some((item) => parseIso(item.date) === null || (item.price !== null && (!Number.isFinite(item.price) || item.price < 0))
    || (item.oscillator !== null && !Number.isFinite(item.oscillator)))) throw new RangeError("oscillator points contain invalid dates or values");
  if (new Set(points.map((item) => parseIso(item.date))).size !== points.length) throw new RangeError("oscillator dates must be unique");
  const visible = datedVisible(points, options.cutoff);
  if (visible.length < 2 * options.pivotK + 1) return { status: "unsupported", reason: "insufficient history for confirmed pivots" };
  const pivots: number[] = [];
  for (let i = options.pivotK; i + options.pivotK < visible.length; i++) {
    const price = visible[i].price;
    if (price === null) continue;
    const neighbors = visible.slice(i - options.pivotK, i + options.pivotK + 1).filter((_, offset) => offset !== options.pivotK);
    if (neighbors.every((item) => item.price !== null && item.price < price)) pivots.push(i);
  }
  const divergences: DisagreementEvent[] = [];
  for (let p = 1; p < pivots.length; p++) {
    const priorIndex = pivots[p - 1];
    const highIndex = pivots[p];
    const prior = visible[priorIndex];
    const high = visible[highIndex];
    if (high.price === null || prior.price === null || high.price <= prior.price || prior.oscillator === null || high.oscillator === null || high.oscillator > prior.oscillator) continue;
    const priorOscillator = prior.oscillator;
    const confirmationIndex = highIndex + options.pivotK;
    const valley = Math.min(...visible.slice(priorIndex, highIndex + 1).flatMap((item) => item.price === null ? [] : [item.price]));
    const later = visible.slice(confirmationIndex + 1);
    const resolved = later.find((item) => item.oscillator !== null && item.oscillator > priorOscillator);
    const failed = later.find((item) => item.price !== null && item.price < valley * (1 - options.weaknessBuffer));
    const state: DisagreementEvent["state"] = failed && (!resolved || parseIso(failed.date)! <= parseIso(resolved.date)!) ? "failed"
      : resolved ? "resolved" : "pending";
    divergences.push({ prior_high_date: prior.date, higher_high_date: high.date, available_date: visible[confirmationIndex].date, age: visible.length - 1 - confirmationIndex, state });
  }
  return { status: "computed", divergences };
}

// ── S26-031 Rally-repair failure after structure loss ─────────────────────────

export interface RallyRepairEvent {
  break_date: string;
  broken_level: number;
  state: "failed_repair" | "reclaimed" | "pending" | "unavailable";
  rebound_fraction: number | null;
  invalidation_date: string | null;
}

/** Requires a caller-confirmed higher-low level, then dates a failed repair only after its second closing low. */
export function rallyRepairFailure(bars: readonly DailyBar[], options: {
  cutoff: string;
  confirmed_higher_low: { level: number; confirmed_date: string };
}): { status: "computed" | "unsupported"; reason?: string; events?: RallyRepairEvent[] } {
  if (!Number.isFinite(options.confirmed_higher_low.level) || options.confirmed_higher_low.level <= 0 || parseIso(options.confirmed_higher_low.confirmed_date) === null) throw new RangeError("a valid confirmed higher-low level is required");
  const visibleBars = visible(bars, options.cutoff);
  const startIndex = visibleBars.findIndex((item) => parseIso(item.date)! >= parseIso(options.confirmed_higher_low.confirmed_date)!);
  if (startIndex < 0) return { status: "unsupported", reason: "confirmed higher-low date is not observed by cutoff" };
  const breakIndex = visibleBars.findIndex((item, index) => index >= startIndex && parseIso(item.date)! > parseIso(options.confirmed_higher_low.confirmed_date)! && item.close !== null && item.close < options.confirmed_higher_low.level);
  if (breakIndex < 0) return { status: "computed", events: [] };
  const after = visibleBars.slice(breakIndex + 1);
  let trough = visibleBars[breakIndex].close!;
  let rebound_fraction: number | null = null;
  let state: RallyRepairEvent["state"] = "pending";
  let invalidation_date: string | null = null;
  for (const item of after) {
    if (item.close === null) { state = "unavailable"; break; }
    if (item.close >= options.confirmed_higher_low.level) { state = "reclaimed"; break; }
    if (item.close < trough) {
      if (rebound_fraction !== null && rebound_fraction > 0) {
        state = "failed_repair";
        invalidation_date = item.date;
        break;
      }
      trough = item.close;
    } else if (item.close > trough) {
      const denominator = options.confirmed_higher_low.level - trough;
      rebound_fraction = denominator > 0 ? Math.max(0, Math.min(1, (item.close - trough) / denominator)) : null;
    }
  }
  return { status: "computed", events: [{ break_date: visibleBars[breakIndex].date, broken_level: options.confirmed_higher_low.level, state, rebound_fraction, invalidation_date }] };
}

// ── S26-033 Moving-average stack repair order ─────────────────────────────────

export interface StackRepairEvent {
  breakdown_date: string;
  steps: { name: "price_above_short" | "short_above_medium" | "medium_above_long"; date: string | null }[];
  state: "complete" | "incomplete";
  available_date: string | null;
}

/** Records the declared sequence after a bearish stack; one average cross cannot complete all three steps. */
export function movingAverageStackRepair(bars: readonly DailyBar[], options: {
  cutoff: string;
  shortWindow: number;
  mediumWindow: number;
  longWindow: number;
}): { status: "computed" | "unavailable"; reason?: string; transitions?: StackRepairEvent[] } {
  if (![options.shortWindow, options.mediumWindow, options.longWindow].every((value) => Number.isInteger(value) && value >= 2)
    || options.shortWindow >= options.mediumWindow || options.mediumWindow >= options.longWindow) throw new RangeError("moving-average windows must be increasing integers");
  const series = visible(bars, options.cutoff);
  if (series.length < options.longWindow) return { status: "unavailable", reason: "insufficient long-average history" };
  const transitions: StackRepairEvent[] = [];
  let active: StackRepairEvent | null = null;
  for (let i = options.longWindow - 1; i < series.length; i++) {
    const close = series[i].close;
    const short = smaAt(series, i, options.shortWindow);
    const medium = smaAt(series, i, options.mediumWindow);
    const long = smaAt(series, i, options.longWindow);
    if (close === null || short === null || medium === null || long === null) continue;
    if (active === null && close < short && short < medium && medium < long) {
      active = { breakdown_date: series[i].date, steps: [
        { name: "price_above_short", date: null }, { name: "short_above_medium", date: null }, { name: "medium_above_long", date: null },
      ], state: "incomplete", available_date: null };
      transitions.push(active);
      continue;
    }
    if (active === null) continue;
    if (active.steps[0].date === null && close > short) active.steps[0].date = series[i].date;
    if (active.steps[0].date !== null && active.steps[1].date === null && short > medium) active.steps[1].date = series[i].date;
    if (active.steps[1].date !== null && active.steps[2].date === null && medium > long) active.steps[2].date = series[i].date;
    if (active.steps.every((step) => step.date !== null)) {
      active.state = "complete";
      active.available_date = series[i].date;
      active = null;
    }
  }
  return { status: "computed", transitions };
}

// ── S26-034 Crossover survival input ──────────────────────────────────────────

export interface CrossoverRecord {
  crossover_date: string;
  status: "recrossed" | "right_censored" | "unavailable";
  duration_bars: number;
  recross_date: string | null;
  event_observed: boolean;
  censoring_reason: "decision_cutoff" | "hold_horizon" | null;
  split: "training" | "holdout";
  missing_sessions: number;
}

/** Emits event-level time-to-recross/censoring records and does not fit a survival curve. */
export function crossoverSurvivalInput(bars: readonly DailyBar[], options: {
  cutoff: string;
  fastWindow: number;
  slowWindow: number;
  holdBars: number;
  splitDate: string;
}): { status: "computed" | "unavailable"; reason?: string; events?: CrossoverRecord[] } {
  if (!Number.isInteger(options.fastWindow) || options.fastWindow < 2 || !Number.isInteger(options.slowWindow) || options.slowWindow <= options.fastWindow
    || !Number.isInteger(options.holdBars) || options.holdBars < 1 || parseIso(options.splitDate) === null) throw new RangeError("invalid crossover or split settings");
  const series = visible(bars, options.cutoff);
  if (series.length < options.slowWindow + 1) return { status: "unavailable", reason: "insufficient slow-average history" };
  const crossovers: number[] = [];
  for (let i = options.slowWindow; i < series.length; i++) {
    const prevFast = smaAt(series, i - 1, options.fastWindow);
    const prevSlow = smaAt(series, i - 1, options.slowWindow);
    const fast = smaAt(series, i, options.fastWindow);
    const slow = smaAt(series, i, options.slowWindow);
    if (prevFast !== null && prevSlow !== null && fast !== null && slow !== null && prevFast <= prevSlow && fast > slow) crossovers.push(i);
  }
  const events = crossovers.map((index): CrossoverRecord => {
    const after = series.slice(index + 1, index + 1 + options.holdBars);
    let recrossIndex = -1;
    for (let j = index + 1; j <= Math.min(series.length - 1, index + options.holdBars); j++) {
      const fast = smaAt(series, j, options.fastWindow);
      const slow = smaAt(series, j, options.slowWindow);
      if (fast !== null && slow !== null && fast <= slow) { recrossIndex = j; break; }
    }
    const recross = recrossIndex >= 0;
    const pathToEvent = recross ? series.slice(index + 1, recrossIndex + 1) : after;
    const missing_sessions = pathToEvent.filter((item) => item.close === null).length;
    const unavailable = missing_sessions > 0;
    const duration_bars = recross ? recrossIndex - index : Math.min(after.length, options.holdBars);
    const complete = after.length >= options.holdBars;
    return {
      crossover_date: series[index].date, status: unavailable ? "unavailable" : recross ? "recrossed" : "right_censored", duration_bars,
      recross_date: recross && !unavailable ? series[recrossIndex].date : null, event_observed: recross && !unavailable,
      censoring_reason: unavailable ? null : recross ? null : complete ? "hold_horizon" : "decision_cutoff",
      split: parseIso(series[index].date)! < parseIso(options.splitDate)! ? "training" : "holdout",
      missing_sessions,
    };
  });
  return { status: "computed", events };
}

// ── S26-036 Transition after long-average reclaim ──────────────────────────────

export interface ReclaimTransitionEvent {
  reclaim_date: string;
  state: "higher_low_confirmed" | "failed_reclaim" | "pending";
  higher_low_date: string | null;
  higher_low_available_date: string | null;
  max_interim_drawdown_pct: number;
}

/** Finds a confirmed higher close-pivot after a long-average reclaim and records the maximum interim drawdown. */
export function transitionAfterLongAverageReclaim(bars: readonly DailyBar[], options: { cutoff: string; longWindow: number; pivotK: number }): {
  status: "computed" | "unavailable"; reason?: string; events?: ReclaimTransitionEvent[];
} {
  if (!Number.isInteger(options.longWindow) || options.longWindow < 2 || !Number.isInteger(options.pivotK) || options.pivotK < 1) throw new RangeError("invalid moving-average or pivot settings");
  const series = visible(bars, options.cutoff);
  if (series.length < options.longWindow) return { status: "unavailable", reason: "insufficient long-average history" };
  const pivots: number[] = [];
  for (let i = options.pivotK; i + options.pivotK < series.length; i++) {
    const close = series[i].close;
    const neighbors = series.slice(i - options.pivotK, i + options.pivotK + 1).filter((_, offset) => offset !== options.pivotK);
    if (close !== null && neighbors.every((item) => item.close !== null && item.close > close)) pivots.push(i);
  }
  const events: ReclaimTransitionEvent[] = [];
  for (let i = options.longWindow; i < series.length; i++) {
    const previousSma = smaAt(series, i - 1, options.longWindow);
    const currentSma = smaAt(series, i, options.longWindow);
    if (previousSma === null || currentSma === null || series[i - 1].close === null || series[i].close === null
      || series[i - 1].close! >= previousSma || series[i].close! <= currentSma) continue;
    const priorPivot = pivots.filter((index) => index < i).at(-1);
    if (priorPivot === undefined) continue;
    const priorLow = series[priorPivot].close!;
    const futurePivots = pivots.filter((index) => index > i && index + options.pivotK < series.length);
    let state: ReclaimTransitionEvent["state"] = "pending";
    let higherLow: number | undefined;
    let failed = false;
    for (let j = i + 1; j < series.length; j++) {
      const sma = smaAt(series, j, options.longWindow);
      if (sma !== null && series[j].close !== null && series[j].close! < sma) { failed = true; break; }
      const pivot = futurePivots.find((index) => index + options.pivotK === j && series[index].close! > priorLow);
      if (pivot !== undefined) { higherLow = pivot; break; }
    }
    if (higherLow !== undefined) state = "higher_low_confirmed";
    else if (failed) state = "failed_reclaim";
    const reclaimClose = series[i].close!;
    const lows = series.slice(i, (higherLow === undefined ? series.length - 1 : higherLow + options.pivotK) + 1).flatMap((item) => item.low === null ? [] : [item.low]);
    const minLow = lows.length ? Math.min(...lows) : reclaimClose;
    events.push({
      reclaim_date: series[i].date, state,
      higher_low_date: higherLow === undefined ? null : series[higherLow].date,
      higher_low_available_date: higherLow === undefined ? null : series[higherLow + options.pivotK].date,
      max_interim_drawdown_pct: (reclaimClose - minLow) / reclaimClose * 100,
    });
  }
  return { status: "computed", events };
}
