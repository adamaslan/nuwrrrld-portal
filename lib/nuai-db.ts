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

/**
 * Atomically add `tokens` to today's running total and return the resulting
 * total, in one round trip. Unlike `getUsedTokensToday` + a caller-side
 * comparison, this closes the check-then-act race CodeRabbit flagged on PR
 * #135: two concurrent requests for the same user both reading "budget
 * available" and both proceeding. The single UPSERT...RETURNING here is one
 * atomic statement — Postgres serializes concurrent writers on the same
 * (user_id, usage_date) row, so each caller's RETURNING reflects the total
 * *after* its own increment has been applied, never a stale read.
 *
 * Returns `null` on DB error so the caller can fail open (matches
 * `addTokenUsage`'s existing convention — a metering outage shouldn't block
 * the product) via `reservationExceedsBudget` in lib/nuai.ts.
 */
export async function reserveTokens(userId: string, tokens: number): Promise<number | null> {
  if (tokens <= 0) return getUsedTokensToday(userId);
  try {
    const rows = await sql`
      INSERT INTO nuai_usage (user_id, usage_date, tokens)
      VALUES (${userId}, CURRENT_DATE, ${tokens})
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET tokens = nuai_usage.tokens + excluded.tokens
      RETURNING tokens
    `;
    return (rows[0]?.tokens as number) ?? null;
  } catch {
    return null;
  }
}

/**
 * Compensating release for a reservation that pushed the day's total over
 * budget — undoes exactly the amount `reserveTokens` just added, so a
 * rejected request never counts against the user's quota. Never drops the
 * total below zero (a concurrent release racing a concurrent add is possible
 * but harmless: it only ever under-counts usage, never lets a request
 * proceed that shouldn't have).
 */
export async function releaseTokens(userId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  try {
    await sql`
      UPDATE nuai_usage
      SET tokens = GREATEST(tokens - ${tokens}, 0)
      WHERE user_id = ${userId} AND usage_date = CURRENT_DATE
    `;
  } catch {
    /* non-fatal — matches addTokenUsage's convention */
  }
}
