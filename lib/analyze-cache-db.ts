/**
 * Per-ticker analyze cache — Neon-backed, same degrade-don't-fail shape as
 * lib/holdfold-cache-db.ts. Distinct from that table: holdfold_cache holds one
 * whole-market batch payload; this holds one payload per (ticker, request-shape),
 * because the same symbol with a different period/asset_type/risk_profile is a
 * different analysis result.
 */
import sql from "@/lib/db";

export { analyzeCacheKey } from "@/lib/shared/analyze-policy";

const CACHE_TTL_MINUTES = 15;

export async function getCachedAnalysis(key: string): Promise<unknown | null> {
  try {
    const rows = await sql`
      SELECT payload FROM analyze_cache
      WHERE cache_key = ${key} AND generated_at > now() - (${CACHE_TTL_MINUTES} * interval '1 minute')
      ORDER BY generated_at DESC
      LIMIT 1
    `;
    return rows.length ? rows[0].payload : null;
  } catch {
    return null;
  }
}

export async function saveAnalysis(key: string, symbol: string, payload: unknown): Promise<void> {
  try {
    await sql`
      INSERT INTO analyze_cache (cache_key, symbol, payload) VALUES (${key}, ${symbol}, ${JSON.stringify(payload)})
    `;
  } catch {
    // non-fatal — next request just re-fetches from the backend
  }
}
