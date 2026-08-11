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
