/**
 * Hold/Fold verdict cache — Neon-backed (audit 2026-07-15: replaces the
 * in-memory module-level `cached` variable in app/api/holdfold/route.ts,
 * which was lost on every cold start and caused backend hammering right
 * after each deploy).
 *
 * Same shape as lib/digest-cache-db.ts: every function is try/catch guarded
 * so a DB outage or un-migrated table degrades to a live re-fetch instead of
 * a hard failure.
 */
import sql from "@/lib/db";
import type { HoldFoldPayload } from "@/app/api/holdfold/route";

const CACHE_TTL_MINUTES = 15;

export async function getLatestHoldFoldCache(): Promise<HoldFoldPayload | null> {
  try {
    const rows = await sql`
      SELECT payload
      FROM holdfold_cache
      WHERE generated_at > now() - (${CACHE_TTL_MINUTES} * interval '1 minute')
      ORDER BY generated_at DESC
      LIMIT 1
    `;
    if (!rows.length) return null;
    return rows[0].payload as HoldFoldPayload;
  } catch {
    return null;
  }
}

export async function saveHoldFoldCache(payload: HoldFoldPayload): Promise<void> {
  try {
    await sql`
      INSERT INTO holdfold_cache (payload) VALUES (${JSON.stringify(payload)})
    `;
  } catch {
    // non-fatal — in-memory L1 cache still works for this instance
  }
}
