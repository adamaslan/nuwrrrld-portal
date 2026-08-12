/**
 * analyze-policy — pure cache-key derivation for per-ticker analysis. Kept
 * separate from lib/analyze-cache-db.ts precisely so it can be unit-tested
 * without pulling in @/lib/db (which throws at import when DATABASE_URL is
 * unset) — same rationale as lib/shared/signal-policy.ts.
 */
import { djb2 } from "@/lib/disclaimer";

export interface AnalyzeRequestShape {
  symbol: string;
  period: string;
  assetType: string;
  riskProfile: string;
}

/** Cache key intentionally excludes position lots — P&L is derived from the
 *  cached market analysis, not re-fetched per position. */
export function analyzeCacheKey(req: AnalyzeRequestShape): string {
  return djb2(`${req.symbol}|${req.period}|${req.assetType}|${req.riskProfile}`);
}

/** Fields the backend factors into its response but the cache key above
 *  deliberately omits. A response shaped by any of these is specific to the
 *  request that produced it and must never be served to a different caller —
 *  caching it under the position-agnostic key above would leak one user's
 *  options/position-shaped output to anyone else querying the same ticker. */
export interface AnalyzePersonalizationFields {
  options_strategy?: string | null;
  options_legs?: unknown[] | null;
  position_qty?: number | null;
  position_entry?: number | null;
  position_lots?: unknown[] | null;
}

/** True only for a plain market-analysis request with no options/position
 *  shaping — the sole case safe to read from or write to the shared cache. */
export function isGenericAnalyzeRequest(req: AnalyzePersonalizationFields): boolean {
  return (
    !req.options_strategy &&
    !(req.options_legs && req.options_legs.length) &&
    req.position_qty == null &&
    req.position_entry == null &&
    !(req.position_lots && req.position_lots.length)
  );
}
