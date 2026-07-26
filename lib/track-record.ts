/**
 * Aggregate rolling hit-rate across backtest_hit_rates, for the landing
 * page's public "receipts" stat. Guarded — returns null on any failure or
 * when the table is empty (e.g. a fresh dev/staging DB), so the landing page
 * can fall back to plain "building our track record" copy instead of a
 * broken or misleading number.
 */
import sql from "@/lib/db";

export interface AggregateTrackRecord {
  hitRatePct: number;
  totalCalls: number;
}

export async function getAggregateTrackRecord(): Promise<AggregateTrackRecord | null> {
  try {
    const rows = await sql`
      SELECT sum(hits)::int AS total_hits, sum(total)::int AS total_calls
      FROM backtest_hit_rates
    `;
    const totalHits = (rows[0]?.total_hits as number) ?? 0;
    const totalCalls = (rows[0]?.total_calls as number) ?? 0;
    if (totalCalls === 0) return null;
    return { hitRatePct: Math.round((totalHits / totalCalls) * 100), totalCalls };
  } catch {
    return null;
  }
}
