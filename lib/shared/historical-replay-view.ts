/** Pure reader for PR51's current offline manifest shape. No I/O, DB or live view mutation.
 * This is a legacy unversioned research manifest, never a production prior grant.
 */
export interface ReplayBucket {
  basis: string; category: string; strength: string; horizonBars: number;
  hits: number; misses: number; flat: number; pending: number;
  resolved: number; hitRate: number | null;
}
export interface HistoricalReplayVM {
  mode: "reconstructed";
  label: "Historical backtest reconstruction, not a live track record";
  format: "signals-pr51-unversioned-research";
  productionPriorEligible: false;
  decisionStart: string; observationCutoff: string; computedAt: string;
  seedHash: string; engineHash: string;
  requested: number; complete: number; partial: number; missing: number; errors: number; unsupported: number;
  mixedInputBasis: boolean; basisPolicy: string;
  bases: Array<{ id: string; source: string; adjustment: string }>;
  coverage: Array<{ ticker: string; status: string }>;
  priceBasis: { source: string; adjustment: string; calendarPolicy: string };
  horizons: number[];
  buckets: ReplayBucket[];
  councilHistory: "not_available"; judgeHistory: "not_available";
}
export type ReplayReadResult =
  | { status: "not_computed"; view: null }
  | { status: "invalid_run"; view: null; reason: string }
  | { status: "complete" | "partial"; view: HistoricalReplayVM };

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const isoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const statuses = new Set(["ok", "degraded", "missing_history", "error", "insufficient_warmup", "no_window_bars", "partial_calendar_coverage", "unsupported_asset_type"]);
const invalid = (reason: string): ReplayReadResult => ({ status: "invalid_run", view: null, reason });

/** Caller supplies its pinned expected universe/hash and current UTC date.
 * Success means parseable research data, never complete hydration or trading advice.
 */
export function readHistoricalReplay(input: unknown, expected: {
  tickers: readonly string[]; seedHash: string; engineHash: string; today: string;
}): ReplayReadResult {
  if (input == null) return { status: "not_computed", view: null };
  if (!object(input) || input.mode !== "reconstructed_point_in_time") return invalid("wrong reconstruction mode");
  if (!isoDate(expected.today) || !hash(expected.seedHash) || !hash(expected.engineHash)) return invalid("invalid expected provenance");
  const { decision_start: start, observation_cutoff: cutoff, computed_at: computed } = input;
  if (!isoDate(start) || !isoDate(cutoff) || start > cutoff || cutoff > expected.today) return invalid("invalid decision window");
  if (!text(computed) || Number.isNaN(Date.parse(computed)) || computed.slice(0, 10) < cutoff
    || computed.slice(0, 10) > expected.today) return invalid("invalid compute timestamp");
  if (input.seed_sha256 !== expected.seedHash || input.engine_source_sha256 !== expected.engineHash) return invalid("provenance hash mismatch");
  if (input.warmup_bars !== 200 || input.price_return_only !== true) return invalid("unsupported methodology");
  if (!object(input.source) || !text(input.source.source) || !text(input.source.adjustment)
    || !text(input.source.calendar_policy) || !text(input.source.retrieved_at)) return invalid("missing price basis");
  if (typeof input.mixed_input_basis !== "boolean" || !text(input.basis_policy)
    || !text(input.signal_suitability_policy) || !Array.isArray(input.distinct_input_bases)
    || !input.distinct_input_bases.length
    || !input.distinct_input_bases.every(b => object(b) && text(b.id) && text(b.source) && text(b.adjustment)))
    return invalid("missing basis declaration");
  const declaredBases = input.distinct_input_bases as Array<{ id: string; source: string; adjustment: string }>;
  if (new Set(declaredBases.map(b => b.id)).size !== declaredBases.length) return invalid("duplicate basis id");
  const declaredBasisIds = new Set(declaredBases.map(b => b.id));
  const horizons = input.horizons_observed_bars;
  if (!Array.isArray(horizons) || !horizons.length || !horizons.every(h => count(h) && h > 0)
    || new Set(horizons).size !== horizons.length) return invalid("invalid horizons");
  const expectedSet = new Set(expected.tickers);
  if (expectedSet.size !== expected.tickers.length || !expectedSet.size
    || input.requested_tickers !== expectedSet.size || !Array.isArray(input.ledger)
    || input.ledger.length !== expectedSet.size) return invalid("universe count mismatch");
  const seen = new Set<string>();
  const coverage: HistoricalReplayVM["coverage"] = [];
  let complete = 0, partial = 0, missing = 0, errors = 0, unsupported = 0;
  for (const r of input.ledger) {
    if (!object(r) || !text(r.ticker) || !expectedSet.has(r.ticker) || seen.has(r.ticker)
      || !text(r.status) || !statuses.has(r.status)) return invalid("invalid or duplicate symbol ledger");
    seen.add(r.ticker);
    if (r.status === "ok") {
      if (!count(r.warmup_available) || r.warmup_available < 200 || !count(r.decision_bars)
        || r.decision_bars === 0 || r.decision_bars !== r.expected_decision_bars
        || !Array.isArray(r.missing_decision_dates) || r.missing_decision_dates.length
        || !Array.isArray(r.unexpected_decision_dates) || r.unexpected_decision_dates.length
        || !hash(r.input_sha256) || !isoDate(r.first_decision) || !isoDate(r.last_decision)
        || r.first_decision < start || r.last_decision > cutoff || r.first_decision > r.last_decision) return invalid("false complete symbol");
      complete++;
    } else if (r.status === "missing_history") missing++;
    else if (r.status === "error") errors++;
    else if (r.status === "unsupported_asset_type") {
      if (!text(r.signal_suitability)) return invalid("unsupported symbol without suitability reason");
      unsupported++;
    } else partial++;
    coverage.push({ ticker: r.ticker, status: r.status });
  }
  if (!Array.isArray(input.pooled_category_strength_horizon)) return invalid("missing aggregate buckets");
  const buckets: ReplayBucket[] = [];
  const bucketKeys = new Set<string>();
  for (const b of input.pooled_category_strength_horizon) {
    if (!object(b) || !text(b.basis) || !declaredBasisIds.has(b.basis) || !text(b.category) || !text(b.strength) || !horizons.includes(b.horizon_bars)
      || ![b.hits, b.misses, b.flat, b.pending, b.resolved_directional].every(count)) return invalid("invalid bucket counts");
    const hits = b.hits as number, misses = b.misses as number, flat = b.flat as number;
    const resolved = hits + misses + flat;
    const key = JSON.stringify([b.basis, b.category, b.strength, b.horizon_bars]);
    if (!Number.isSafeInteger(resolved) || resolved !== b.resolved_directional || bucketKeys.has(key)) return invalid("inconsistent or duplicate bucket");
    const rate = resolved >= 30 ? hits / resolved : null;
    if (b.hit_rate !== rate) return invalid("invalid display-rate denominator");
    bucketKeys.add(key);
    buckets.push({ basis: b.basis, category: b.category, strength: b.strength, horizonBars: b.horizon_bars as number,
      hits, misses, flat, pending: b.pending as number, resolved, hitRate: rate });
  }
  if (!complete && buckets.some(b => b.resolved > 0 || b.pending > 0)) return invalid("aggregate without eligible inputs");
  const view: HistoricalReplayVM = {
    mode: "reconstructed", label: "Historical backtest reconstruction, not a live track record",
    format: "signals-pr51-unversioned-research", productionPriorEligible: false,
    decisionStart: start, observationCutoff: cutoff, computedAt: computed,
    seedHash: expected.seedHash, engineHash: expected.engineHash,
    requested: expectedSet.size, complete, partial, missing, errors, unsupported,
    mixedInputBasis: input.mixed_input_basis, basisPolicy: input.basis_policy,
    bases: declaredBases.map(b => ({ id: b.id, source: b.source, adjustment: b.adjustment })), coverage,
    priceBasis: { source: input.source.source, adjustment: input.source.adjustment, calendarPolicy: input.source.calendar_policy },
    horizons: [...horizons], buckets, councilHistory: "not_available", judgeHistory: "not_available",
  };
  return { status: complete === expectedSet.size ? "complete" : "partial", view };
}

/** Exact research lookup only. Basis is REQUIRED: buckets are stratified per price
 * basis, so a category/strength/horizon key alone is ambiguous across feeds and
 * must never silently return the first basis's bucket. Missing combinations stay
 * unknown. This is not wired to live Followed Tickers and is never a production prior.
 */
export function replayResearchBucket(view: HistoricalReplayVM, basis: string, category: string, strength: string, horizonBars: number): ReplayBucket | null {
  return view.buckets.find(b => b.basis === basis && b.category === category && b.strength === strength && b.horizonBars === horizonBars) ?? null;
}
