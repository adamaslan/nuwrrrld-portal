/**
 * Nu AI daily token budget — durable Neon-backed counter (audit 2026-07-15:
 * replaces the in-memory Map in app/api/nuai/route.ts, which reset on every
 * Vercel cold start and let users exceed their daily quota).
 *
 * Fails open on DB errors — matches the council quota pattern in
 * lib/council-db.ts — a metering outage shouldn't block the product.
 */
import sql from "@/lib/db";

export async function getUsedTokensToday(userId: string): Promise<number> {
  try {
    const rows = await sql`
      SELECT tokens FROM nuai_usage WHERE user_id = ${userId} AND usage_date = CURRENT_DATE
    `;
    return (rows[0]?.tokens as number) ?? 0;
  } catch {
    return 0;
  }
}

export async function addTokenUsage(userId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  try {
    await sql`
      INSERT INTO nuai_usage (user_id, usage_date, tokens)
      VALUES (${userId}, CURRENT_DATE, ${tokens})
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET tokens = nuai_usage.tokens + excluded.tokens
    `;
  } catch {
    /* non-fatal — in-memory L1 in the caller still enforces the budget for this instance */
  }
}
