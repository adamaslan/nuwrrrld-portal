import { describe, expect, it } from "vitest";
import { readHistoricalReplay, replayResearchBucket } from "@/lib/shared/historical-replay-view";

interface FixtureLedgerRow {
  ticker: string;
  status: string;
  warmup_available?: number;
  decision_bars?: number;
  expected_decision_bars?: number;
  missing_decision_dates?: string[];
  unexpected_decision_dates?: string[];
  input_sha256?: string;
  first_decision?: string;
  last_decision?: string;
  signal_suitability?: string;
}
interface FixtureBucket {
  basis?: string;
  category: string;
  strength: string;
  horizon_bars: number;
  hits: number;
  misses: number;
  flat: number;
  pending: number;
  resolved_directional: number;
  hit_rate: number | null;
}
interface FixtureManifest {
  mode: string;
  decision_start: string;
  observation_cutoff: string;
  computed_at: string;
  seed_sha256: string;
  engine_source_sha256: string;
  warmup_bars: number;
  price_return_only: boolean;
  source: { source: string; adjustment: string; calendar_policy: string; retrieved_at: string };
  mixed_input_basis?: boolean;
  basis_policy?: string;
  signal_suitability_policy?: string;
  distinct_input_bases?: Array<{ id?: string; source: string; adjustment: string }>;
  horizons_observed_bars: number[];
  requested_tickers: number;
  ledger: FixtureLedgerRow[];
  pooled_category_strength_horizon: FixtureBucket[];
}

const seedHash = "a".repeat(64), engineHash = "b".repeat(64);
const expected = { tickers: ["AAPL", "BTC-USD"], seedHash, engineHash, today: "2026-11-06" };
const manifest = (): FixtureManifest => ({
  mode: "reconstructed_point_in_time", decision_start: "2025-11-06", observation_cutoff: "2026-11-05", computed_at: "2026-11-06T05:00:00Z",
  seed_sha256: seedHash, engine_source_sha256: engineHash, warmup_bars: 200, price_return_only: true,
  source: { source: "FIXTURE, not historical returns", adjustment: "fixture", calendar_policy: "fixture", retrieved_at: "2026-11-06T05:00:00Z" },
  mixed_input_basis: false, basis_policy: "single declared price basis",
  signal_suitability_policy: "fixture policy", distinct_input_bases: [{ id: "basis-0", source: "FIXTURE", adjustment: "fixture" }],
  horizons_observed_bars: [1, 5], requested_tickers: 2,
  ledger: [{ ticker: "AAPL", status: "ok", warmup_available: 250, decision_bars: 251, expected_decision_bars: 251, missing_decision_dates: [], unexpected_decision_dates: [], input_sha256: "c".repeat(64), first_decision: "2025-11-06", last_decision: "2026-11-05" }, { ticker: "BTC-USD", status: "missing_history" }],
  pooled_category_strength_horizon: [{ basis: "basis-0", category: "MACD", strength: "BULLISH", horizon_bars: 5, hits: 20, misses: 9, flat: 1, pending: 5, resolved_directional: 30, hit_rate: 20 / 30 }],
});
describe("isolated reconstructed research manifest reader", () => {
  it("separates absent, partial and reconstructed labels", () => {
    expect(readHistoricalReplay(null, expected).status).toBe("not_computed");
    const result = readHistoricalReplay(manifest(), expected);
    expect(result.status).toBe("partial");
    expect(result.view?.complete).toBe(1);
    expect(result.view?.missing).toBe(1);
    expect(result.view?.mode).toBe("reconstructed");
    expect(result.view?.productionPriorEligible).toBe(false);
    expect(result.view?.councilHistory).toBe("not_available");
  });
  it("requires exact basis category strength horizon, no first-bucket fallback", () => {
    const result = readHistoricalReplay(manifest(), expected);
    if (!result.view) throw new Error("fixture rejected");
    expect(replayResearchBucket(result.view, "basis-0", "RSI", "BULLISH", 5)).toBeNull();
    expect(replayResearchBucket(result.view, "basis-0", "MACD", "BEARISH", 5)).toBeNull();
    expect(replayResearchBucket(result.view, "basis-0", "MACD", "BULLISH", 1)).toBeNull();
    expect(replayResearchBucket(result.view, "basis-1", "MACD", "BULLISH", 5)).toBeNull();
    expect(replayResearchBucket(result.view, "basis-0", "MACD", "BULLISH", 5)?.resolved).toBe(30);
  });
  it("selects the requested basis when identical keys exist in two feeds", () => {
    const m = manifest();
    m.distinct_input_bases = [{ id: "basis-0", source: "FIXTURE", adjustment: "fixture" }, { id: "basis-1", source: "FEED-B", adjustment: "raw" }];
    m.pooled_category_strength_horizon.push({ basis: "basis-1", category: "MACD", strength: "BULLISH", horizon_bars: 5, hits: 5, misses: 5, flat: 0, pending: 0, resolved_directional: 10, hit_rate: null });
    const r = readHistoricalReplay(m, expected);
    if (!r.view) throw new Error("fixture rejected");
    expect(replayResearchBucket(r.view, "basis-0", "MACD", "BULLISH", 5)?.resolved).toBe(30);
    expect(replayResearchBucket(r.view, "basis-1", "MACD", "BULLISH", 5)?.resolved).toBe(10);
    // an unknown or shifted basis must return null, never another basis's bucket
    expect(replayResearchBucket(r.view, "MACD", "BULLISH", 5 as unknown as string, undefined as unknown as number)).toBeNull();
  });
  it.each(["seed_sha256", "engine_source_sha256"] as const)("rejects changed %s", field => {
    const m = manifest(); m[field] = "d".repeat(64); expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
  });
  it("rejects duplicate symbols or silent missing ledger", () => {
    const m = manifest(); m.ledger[1] = { ...m.ledger[0] }; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
    m.ledger.pop(); expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
  });
  it("does not accept false calendar completion or insufficient warmup", () => {
    const m = manifest(); m.ledger[0].warmup_available = 199; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
    m.ledger[0].warmup_available = 250; m.ledger[0].expected_decision_bars = 252; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
  });
  it("rejects future cutoff, impossible date and wrong bucket denominators", () => {
    const m = manifest(); m.observation_cutoff = "2026-11-07"; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
    m.observation_cutoff = "2026-02-30"; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
    m.observation_cutoff = "2026-11-05"; m.pooled_category_strength_horizon[0].resolved_directional = 29; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
  });
  it("requires null rate below actual n30, not a fake zero", () => {
    const m = manifest(); const b = m.pooled_category_strength_horizon[0]; b.misses = 8; b.resolved_directional = 29; b.hit_rate = null;
    expect(readHistoricalReplay(m, expected).status).toBe("partial"); b.hit_rate = 0; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
  });
  it("accepts unsupported_asset_type, counts it separately, never as complete or pooled-eligible", () => {
    const m = manifest();
    m.ledger[1] = { ticker: "BTC-USD", status: "unsupported_asset_type", signal_suitability: "unsupported: fixture reason" };
    const result = readHistoricalReplay(m, expected);
    expect(result.status).toBe("partial");
    expect(result.view?.unsupported).toBe(1);
    expect(result.view?.partial).toBe(0);
    expect(result.view?.coverage).toContainEqual({ ticker: "BTC-USD", status: "unsupported_asset_type" });
    const bare = manifest(); bare.ledger[1] = { ticker: "BTC-USD", status: "unsupported_asset_type" };
    expect(readHistoricalReplay(bare, expected).status).toBe("invalid_run");
    const bogus = manifest(); bogus.ledger[1].status = "eligibleish";
    expect(readHistoricalReplay(bogus, expected).status).toBe("invalid_run");
  });
  it("rejects manifests without explicit basis declaration", () => {
    const m = manifest(); delete m.mixed_input_basis;
    expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
    const n = manifest(); n.distinct_input_bases = [];
    expect(readHistoricalReplay(n, expected).status).toBe("invalid_run");
    const mixed = manifest(); mixed.mixed_input_basis = true; mixed.basis_policy = "pooled aggregates span multiple price bases; descriptive only, not a calibrated prior";
    const r = readHistoricalReplay(mixed, expected);
    expect(r.status).toBe("partial");
    expect(r.view?.mixedInputBasis).toBe(true);
  });
  it("keeps identical signals in separate basis buckets, no cross-basis combination", () => {
    const m = manifest();
    m.distinct_input_bases = [{ id: "basis-0", source: "FIXTURE", adjustment: "fixture" }, { id: "basis-1", source: "FEED-B", adjustment: "raw" }];
    m.pooled_category_strength_horizon.push({ basis: "basis-1", category: "MACD", strength: "BULLISH", horizon_bars: 5, hits: 5, misses: 5, flat: 0, pending: 0, resolved_directional: 10, hit_rate: null });
    const r = readHistoricalReplay(m, expected);
    expect(r.status).toBe("partial");
    expect(r.view?.buckets.map(b => b.basis).sort()).toEqual(["basis-0", "basis-1"]);
    const dup = manifest();
    dup.pooled_category_strength_horizon.push({ ...dup.pooled_category_strength_horizon[0] });
    expect(readHistoricalReplay(dup, expected).status).toBe("invalid_run");
    const basisless = manifest();
    delete basisless.pooled_category_strength_horizon[0].basis;
    expect(readHistoricalReplay(basisless, expected).status).toBe("invalid_run");
  });
  it("exposes declared bases and rejects buckets against an undeclared basis", () => {
    const r = readHistoricalReplay(manifest(), expected);
    expect(r.view?.bases).toEqual([{ id: "basis-0", source: "FIXTURE", adjustment: "fixture" }]);
    const undeclared = manifest();
    undeclared.pooled_category_strength_horizon[0].basis = "basis-9";
    expect(readHistoricalReplay(undeclared, expected).status).toBe("invalid_run");
    const dupIds = manifest();
    dupIds.distinct_input_bases = [{ id: "basis-0", source: "A", adjustment: "a" }, { id: "basis-0", source: "B", adjustment: "b" }];
    expect(readHistoricalReplay(dupIds, expected).status).toBe("invalid_run");
  });
  it("rejects NaN, negative counts and duplicated aggregate keys", () => {
    const m = manifest(); m.pooled_category_strength_horizon[0].hits = NaN; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
    m.pooled_category_strength_horizon[0].hits = -1; expect(readHistoricalReplay(m, expected).status).toBe("invalid_run");
    const n = manifest(); n.pooled_category_strength_horizon.push({ ...n.pooled_category_strength_horizon[0] }); expect(readHistoricalReplay(n, expected).status).toBe("invalid_run");
  });
});
