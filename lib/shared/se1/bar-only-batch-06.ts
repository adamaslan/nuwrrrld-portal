/**
 * S26-067..071 and S26-082. Deterministic cross-sectional and event-window input diagnostics.
 * Cohorts, classifications, dates and benchmark bases are explicit; outputs are not forecasts.
 */

import { parseIso } from "@/lib/shared/se1/util";

function requireDate(value: string, label: string): void {
  if (parseIso(value) === null) throw new RangeError(`${label} must be a valid ISO date`);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// ── S26-067 Sector-relative rank migration matrix ─────────────────────────────

export interface SectorRankMember {
  ticker: string;
  priorSector: string;
  currentSector: string;
  priorReturn: number | null;
  currentReturn: number | null;
  priorMember: boolean;
  currentMember: boolean;
}

function averageRanks<T>(items: readonly T[], score: (item: T) => number, label: (item: T) => string): Map<string, number> {
  const sorted = [...items].sort((a, b) => score(b) - score(a) || label(a).localeCompare(label(b)));
  const out = new Map<string, number>();
  for (let i = 0; i < sorted.length;) {
    let end = i + 1;
    while (end < sorted.length && score(sorted[end]) === score(sorted[i])) end++;
    const rank = ((i + 1) + end) / 2;
    for (let j = i; j < end; j++) out.set(label(sorted[j]), rank);
    i = end;
  }
  return out;
}

/** Reclassification and missing scores are counted separately and never placed in a low-rank bucket. */
export function sectorRankMigrationMatrix(members: readonly SectorRankMember[], options: {
  priorDate: string;
  currentDate: string;
  bucketCount: number;
}): { prior_date: string; current_date: string; comparable_members: number; transitions: { from_sector: string; from_bucket: number; to_sector: string; to_bucket: number; count: number }[];
  tie_count: { prior: number; current: number }; exclusions: { membership_changed: number; reclassified: number; missing_score: number } } {
  requireDate(options.priorDate, "priorDate");
  requireDate(options.currentDate, "currentDate");
  if (options.priorDate >= options.currentDate || !Number.isInteger(options.bucketCount) || options.bucketCount < 2) throw new RangeError("invalid comparison dates or bucket count");
  if (new Set(members.map((item) => item.ticker)).size !== members.length) throw new RangeError("tickers must be unique");
  if (members.some((item) => (item.priorReturn !== null && !Number.isFinite(item.priorReturn)) || (item.currentReturn !== null && !Number.isFinite(item.currentReturn)))) throw new RangeError("returns must be finite or null");
  const membership_changed = members.filter((item) => item.priorMember !== item.currentMember).length;
  const reclassified = members.filter((item) => item.priorMember && item.currentMember && item.priorSector !== item.currentSector).length;
  const missing_score = members.filter((item) => item.priorMember && item.currentMember && item.priorSector === item.currentSector
    && (item.priorReturn === null || item.currentReturn === null)).length;
  const comparable = members.filter((item) => item.priorMember && item.currentMember && item.priorSector === item.currentSector
    && item.priorReturn !== null && item.currentReturn !== null);
  const sectors = [...new Set(comparable.map((item) => item.priorSector))];
  const priorRanks = new Map<string, number>();
  const currentRanks = new Map<string, number>();
  let priorTies = 0;
  let currentTies = 0;
  for (const sector of sectors) {
    const group = comparable.filter((item) => item.priorSector === sector);
    const countTies = (field: "priorReturn" | "currentReturn") => group.length - new Set(group.map((item) => item[field])).size;
    priorTies += countTies("priorReturn");
    currentTies += countTies("currentReturn");
    for (const [ticker, rank] of averageRanks(group, (item) => item.priorReturn!, (item) => item.ticker)) priorRanks.set(ticker, rank);
    for (const [ticker, rank] of averageRanks(group, (item) => item.currentReturn!, (item) => item.ticker)) currentRanks.set(ticker, rank);
  }
  const bucket = (rank: number, denominator: number) => Math.min(options.bucketCount - 1, Math.floor((rank - 1) / denominator * options.bucketCount));
  const counts = new Map<string, { from_sector: string; from_bucket: number; to_sector: string; to_bucket: number; count: number }>();
  for (const item of comparable) {
    const from_bucket = bucket(priorRanks.get(item.ticker)!, comparable.filter((other) => other.priorSector === item.priorSector).length);
    const to_bucket = bucket(currentRanks.get(item.ticker)!, comparable.filter((other) => other.currentSector === item.currentSector).length);
    const key = `${item.priorSector}:${from_bucket}->${item.currentSector}:${to_bucket}`;
    const prior = counts.get(key);
    if (prior) prior.count++;
    else counts.set(key, { from_sector: item.priorSector, from_bucket, to_sector: item.currentSector, to_bucket, count: 1 });
  }
  return {
    prior_date: options.priorDate, current_date: options.currentDate, comparable_members: comparable.length,
    transitions: [...counts.values()], tie_count: { prior: priorTies, current: currentTies },
    exclusions: { membership_changed, reclassified, missing_score },
  };
}

// ── S26-068 Market-neutral residual persistence ───────────────────────────────

export interface FactorReturnRow {
  date: string;
  assetReturn: number;
  marketReturn: number;
  sectorReturn: number;
}

function solve3(matrix: number[][], vector: number[]): number[] | null {
  const augmented = matrix.map((row, i) => [...row, vector[i]]);
  let smallestPivot = Infinity;
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    const magnitude = Math.abs(augmented[pivot][column]);
    if (magnitude < 1e-10) return null;
    smallestPivot = Math.min(smallestPivot, magnitude);
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = column; j < 4; j++) augmented[column][j] /= divisor;
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = column; j < 4; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  if (smallestPivot < 1e-8) return null;
  return augmented.map((row) => row[3]);
}

/** Fits intercept, market and sector coefficients only on training rows, then reports held-out residuals. */
export function marketNeutralResidualPersistence(rows: readonly FactorReturnRow[], options: {
  trainingEndDate: string;
  cutoff: string;
  minTrainingRows: number;
  evaluationWindow: number;
}): { status: "computed" | "unavailable"; reason?: string; fit_window?: { start: string; end: string; rows: number };
  coefficients?: { intercept: number; market: number; sector: number }; evaluation_overlap?: number;
  residual_mean?: number; positive_residual_share?: number; residuals?: { date: string; value: number }[]; interpretation?: string } {
  requireDate(options.trainingEndDate, "trainingEndDate");
  requireDate(options.cutoff, "cutoff");
  if (options.trainingEndDate >= options.cutoff || !Number.isInteger(options.minTrainingRows) || options.minTrainingRows < 4
    || !Number.isInteger(options.evaluationWindow) || options.evaluationWindow < 1) throw new RangeError("invalid training/evaluation settings");
  for (const item of rows) requireDate(item.date, "factor date");
  if (rows.some((item) => ![item.assetReturn, item.marketReturn, item.sectorReturn].every(Number.isFinite))) throw new RangeError("factor rows contain invalid values");
  if (new Set(rows.map((item) => item.date)).size !== rows.length) throw new RangeError("factor dates must be unique");
  const visible = rows.filter((item) => item.date <= options.cutoff).slice().sort((a, b) => a.date.localeCompare(b.date));
  const training = visible.filter((item) => item.date <= options.trainingEndDate);
  if (training.length < options.minTrainingRows) return { status: "unavailable", reason: "too few training rows" };
  const sums = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const target = [0, 0, 0];
  for (const row of training) {
    const x = [1, row.marketReturn, row.sectorReturn];
    for (let i = 0; i < 3; i++) {
      target[i] += x[i] * row.assetReturn;
      for (let j = 0; j < 3; j++) sums[i][j] += x[i] * x[j];
    }
  }
  const coefficients = solve3(sums, target);
  if (coefficients === null) return { status: "unavailable", reason: "singular factor fit" };
  const evaluation = visible.filter((item) => item.date > options.trainingEndDate).slice(-options.evaluationWindow);
  if (evaluation.length === 0) return { status: "unavailable", reason: "no held-out evaluation rows" };
  const residuals = evaluation.map((row) => ({ date: row.date, value: row.assetReturn - (coefficients[0] + coefficients[1] * row.marketReturn + coefficients[2] * row.sectorReturn) }));
  return {
    status: "computed", fit_window: { start: training[0].date, end: training.at(-1)!.date, rows: training.length },
    coefficients: { intercept: coefficients[0], market: coefficients[1], sector: coefficients[2] },
    evaluation_overlap: evaluation.length, residual_mean: mean(residuals.map((item) => item.value)),
    positive_residual_share: residuals.filter((item) => item.value > 0).length / residuals.length,
    residuals, interpretation: "descriptive residual only; not evidence of causal idiosyncratic return",
  };
}

// ── S26-069 Rebound participation asymmetry ───────────────────────────────────

export interface PhaseReturnMember {
  ticker: string;
  selloffReturn: number | null;
  reboundReturn: number | null;
}

/** Selloff and rebound phase boundaries are caller-predeclared; unfinished rebound data stays pending. */
export function reboundParticipationAsymmetry(members: readonly PhaseReturnMember[], options: {
  selloffStart: string;
  selloffEnd: string;
  reboundStart: string;
  reboundEnd: string;
  cutoff: string;
  reboundComplete: boolean;
}): { state: "computed" | "pending"; selloff_window: { start: string; end: string }; rebound_window: { start: string; end: string };
  common_members: number; down_phase_breadth: number | null; up_phase_breadth: number | null;
  selloff_coverage: number; rebound_coverage: number } {
  for (const [key, value] of Object.entries({ selloffStart: options.selloffStart, selloffEnd: options.selloffEnd, reboundStart: options.reboundStart, reboundEnd: options.reboundEnd, cutoff: options.cutoff })) requireDate(value, key);
  if (options.selloffStart >= options.selloffEnd || options.selloffEnd >= options.reboundStart || options.reboundStart >= options.reboundEnd) throw new RangeError("phase dates must be ordered");
  if (new Set(members.map((item) => item.ticker)).size !== members.length) throw new RangeError("member tickers must be unique");
  if (members.some((item) => (item.selloffReturn !== null && !Number.isFinite(item.selloffReturn)) || (item.reboundReturn !== null && !Number.isFinite(item.reboundReturn)))) throw new RangeError("phase returns must be finite or null");
  const selloff = members.filter((item) => item.selloffReturn !== null);
  const rebound = members.filter((item) => item.reboundReturn !== null);
  const common = members.filter((item) => item.selloffReturn !== null && item.reboundReturn !== null);
  const complete = options.reboundComplete && options.reboundEnd <= options.cutoff;
  const comparisonSet = complete ? common : selloff;
  return {
    state: complete ? "computed" : "pending", selloff_window: { start: options.selloffStart, end: options.selloffEnd },
    rebound_window: { start: options.reboundStart, end: options.reboundEnd }, common_members: complete ? common.length : 0,
    down_phase_breadth: comparisonSet.length ? comparisonSet.filter((item) => item.selloffReturn! < 0).length / comparisonSet.length : null,
    up_phase_breadth: complete && common.length ? common.filter((item) => item.reboundReturn! > 0).length / common.length : null,
    selloff_coverage: selloff.length / members.length, rebound_coverage: rebound.length / members.length,
  };
}

// ── S26-070 Leadership concentration by industry cluster ─────────────────────

export interface RankedClusterMember {
  ticker: string;
  canonicalId: string;
  score: number;
  industry: string | null;
}

/** Ambiguous duplicate canonical IDs are all excluded, so share classes cannot inflate leader counts. */
export function leadershipClusterConcentration(members: readonly RankedClusterMember[], options: { classificationVersion: string; topN: number }): {
  classification_version: string; ranking_population: number; duplicate_canonical_excluded: number;
  top_members: string[]; unclassified_top_members: number; cluster_counts: Record<string, number>; cluster_shares: Record<string, number>; concentration_hhi: number | null;
} {
  if (!options.classificationVersion.trim() || !Number.isInteger(options.topN) || options.topN < 1) throw new RangeError("classification version and topN are required");
  if (new Set(members.map((item) => item.ticker)).size !== members.length || members.some((item) => !Number.isFinite(item.score))) throw new RangeError("tickers and scores must be unique and finite");
  const counts = new Map<string, number>();
  for (const item of members) counts.set(item.canonicalId, (counts.get(item.canonicalId) ?? 0) + 1);
  const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
  const eligible = members.filter((item) => !duplicates.has(item.canonicalId)).sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  const top = eligible.slice(0, options.topN);
  const cluster_counts: Record<string, number> = {};
  let unclassified_top_members = 0;
  for (const item of top) {
    if (item.industry === null || !item.industry.trim()) unclassified_top_members++;
    else cluster_counts[item.industry] = (cluster_counts[item.industry] ?? 0) + 1;
  }
  const classifiedCount = Object.values(cluster_counts).reduce((sum, count) => sum + count, 0);
  const cluster_shares = Object.fromEntries(Object.entries(cluster_counts).map(([industry, count]) => [industry, classifiedCount ? count / classifiedCount : 0]));
  const values = Object.values(cluster_shares);
  return {
    classification_version: options.classificationVersion, ranking_population: eligible.length,
    duplicate_canonical_excluded: members.length - eligible.length, top_members: top.map((item) => item.ticker),
    unclassified_top_members, cluster_counts, cluster_shares, concentration_hhi: values.length ? values.reduce((sum, value) => sum + value ** 2, 0) : null,
  };
}

// ── S26-071 Benchmark-choice rank sensitivity ──────────────────────────────────

export interface RelativeReturnMember {
  ticker: string;
  stockReturn: number | null;
  marketBenchmarkReturn: number | null;
  sectorBenchmarkReturn: number | null;
}

/** Benchmarks are declared up front and must share a total-return basis; neither is selected after seeing ranks. */
export function benchmarkChoiceRankSensitivity(focusTicker: string, members: readonly RelativeReturnMember[], options: {
  marketBenchmarkId: string;
  sectorBenchmarkId: string;
  marketBasis: "total_return" | "price_return";
  sectorBasis: "total_return" | "price_return";
  topN: number;
}): { status: "computed" | "unsupported"; reason?: string; market_benchmark?: string; sector_benchmark?: string;
  denominator?: number; market_rank?: number; sector_rank?: number; market_relative_return?: number; sector_relative_return?: number;
  conclusion_changed?: boolean } {
  if (!options.marketBenchmarkId.trim() || !options.sectorBenchmarkId.trim() || !Number.isInteger(options.topN) || options.topN < 1) throw new RangeError("benchmark identifiers and topN are required");
  if (options.marketBasis !== "total_return" || options.sectorBasis !== "total_return") return { status: "unsupported", reason: "benchmark return bases are incompatible or not total-return adjusted" };
  if (new Set(members.map((item) => item.ticker)).size !== members.length) throw new RangeError("tickers must be unique");
  const eligible = members.filter((item) => item.stockReturn !== null && item.marketBenchmarkReturn !== null && item.sectorBenchmarkReturn !== null);
  if (eligible.some((item) => ![item.stockReturn, item.marketBenchmarkReturn, item.sectorBenchmarkReturn].every(Number.isFinite))) throw new RangeError("returns must be finite");
  const focus = eligible.find((item) => item.ticker === focusTicker);
  if (!focus) return { status: "unsupported", reason: "focus ticker lacks comparable returns" };
  const marketOrder = [...eligible].sort((a, b) => (b.stockReturn! - b.marketBenchmarkReturn!) - (a.stockReturn! - a.marketBenchmarkReturn!) || a.ticker.localeCompare(b.ticker));
  const sectorOrder = [...eligible].sort((a, b) => (b.stockReturn! - b.sectorBenchmarkReturn!) - (a.stockReturn! - a.sectorBenchmarkReturn!) || a.ticker.localeCompare(b.ticker));
  const market_rank = marketOrder.findIndex((item) => item.ticker === focusTicker) + 1;
  const sector_rank = sectorOrder.findIndex((item) => item.ticker === focusTicker) + 1;
  const market_relative_return = focus.stockReturn! - focus.marketBenchmarkReturn!;
  const sector_relative_return = focus.stockReturn! - focus.sectorBenchmarkReturn!;
  return {
    status: "computed", market_benchmark: options.marketBenchmarkId, sector_benchmark: options.sectorBenchmarkId,
    denominator: eligible.length, market_rank, sector_rank, market_relative_return, sector_relative_return,
    conclusion_changed: (market_rank <= options.topN) !== (sector_rank <= options.topN),
  };
}

// ── S26-082 Event-window exclusion sensitivity ────────────────────────────────

export interface TechnicalSetupObservation {
  date: string;
  eligible: boolean;
  triggered: boolean;
}

export interface KnownEventWindow {
  eventDate: string;
  knownAt: string;
  beforeBars: number;
  afterBars: number;
}

/** Excludes only event windows known by cutoff and reports count/rate sensitivity without performance claims. */
export function eventWindowExclusionSensitivity(observations: readonly TechnicalSetupObservation[], events: readonly KnownEventWindow[], options: {
  cutoff: string;
  minSampleSize: number;
  exclusionPolicy: "known-at-cutoff-only";
}): { status: "computed" | "unavailable"; reason?: string; baseline?: { eligible: number; triggered: number; rate: number | null };
  excluding_events?: { eligible: number; triggered: number; rate: number | null }; excluded_setups?: number;
  ignored_future_known_events?: number; finding_changed?: boolean | null; sample_state?: "sufficient" | "insufficient" } {
  requireDate(options.cutoff, "cutoff");
  if (!Number.isInteger(options.minSampleSize) || options.minSampleSize < 1 || options.exclusionPolicy !== "known-at-cutoff-only") throw new RangeError("invalid event-window policy");
  if (new Set(observations.map((item) => item.date)).size !== observations.length) throw new RangeError("setup dates must be unique");
  for (const item of observations) {
    requireDate(item.date, "setup date");
    if (item.date > options.cutoff) throw new RangeError("setup observations cannot exceed cutoff");
    if (item.triggered && !item.eligible) throw new RangeError("a triggered setup must be eligible");
  }
  for (const event of events) {
    requireDate(event.eventDate, "eventDate");
    requireDate(event.knownAt, "knownAt");
    if (![event.beforeBars, event.afterBars].every((value) => Number.isInteger(value) && value >= 0)) throw new RangeError("event windows must use non-negative bar counts");
  }
  const known = events.filter((event) => event.knownAt <= options.cutoff && event.eventDate <= options.cutoff);
  const ignored_future_known_events = events.length - known.length;
  const dates = [...new Set(observations.map((item) => item.date))].sort();
  const excludedDates = new Set<string>();
  for (const event of known) {
    const index = dates.findIndex((date) => date >= event.eventDate);
    if (index < 0) continue;
    for (let i = Math.max(0, index - event.beforeBars); i <= Math.min(dates.length - 1, index + event.afterBars); i++) excludedDates.add(dates[i]);
  }
  const baselineRows = observations.filter((item) => item.eligible);
  const retained = baselineRows.filter((item) => !excludedDates.has(item.date));
  const stats = (items: readonly TechnicalSetupObservation[]) => ({
    eligible: items.length, triggered: items.filter((item) => item.triggered).length,
    rate: items.length ? items.filter((item) => item.triggered).length / items.length : null,
  });
  const baseline = stats(baselineRows);
  const excluding_events = stats(retained);
  if (baseline.eligible < options.minSampleSize || excluding_events.eligible < options.minSampleSize) {
    return { status: "unavailable", reason: "insufficient eligible sample after applying the declared event policy", baseline, excluding_events,
      excluded_setups: baseline.eligible - excluding_events.eligible, ignored_future_known_events, finding_changed: null, sample_state: "insufficient" };
  }
  return {
    status: "computed", baseline, excluding_events, excluded_setups: baseline.eligible - excluding_events.eligible,
    ignored_future_known_events, finding_changed: baseline.triggered !== excluding_events.triggered, sample_state: "sufficient",
  };
}

