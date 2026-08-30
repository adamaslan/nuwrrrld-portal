/**
 * First-party acquisition attribution store (docs/todo-auth-cookies-tracking.md
 * Phase 4.1). One row per user, written once at their first authenticated load:
 * first-touch (recovered from the `nu_attrib` cookie set on the anonymous
 * landing visit) plus last-touch (the visit during which they signed in). CAC
 * per channel is then computable with no third-party pixel at all.
 *
 * Write posture matches lib/consent-db.ts: best-effort, fail-open. Attribution
 * is analytics data, gated on `analytics` consent by the caller — a lost write
 * is a lost data point, never a broken request.
 */
import sql from "@/lib/db";
import type { AttributionTouch } from "@/lib/shared/attribution";

/**
 * Insert the user's attribution row if they do not already have one. No-op if a
 * row exists (first-touch must never be overwritten) or on any DB error.
 */
export async function ensureUserAttribution(
  userId: string,
  firstTouch: AttributionTouch | null,
  lastTouch: AttributionTouch | null,
): Promise<void> {
  if (!firstTouch && !lastTouch) return;
  try {
    await sql.query(
      `INSERT INTO user_attribution (user_id, first_touch, last_touch)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        userId,
        firstTouch ? JSON.stringify(firstTouch) : null,
        lastTouch ? JSON.stringify(lastTouch) : null,
      ],
    );
  } catch (err) {
    console.error(
      "user_attribution write failed user_id=%s err=%s",
      userId,
      err instanceof Error ? err.message : "unknown",
    );
  }
}

export async function getUserAttribution(userId: string): Promise<{
  first_touch: AttributionTouch | null;
  last_touch: AttributionTouch | null;
  created_at: string;
} | null> {
  try {
    const rows = await sql.query(
      `SELECT first_touch, last_touch, created_at FROM user_attribution WHERE user_id = $1`,
      [userId],
    );
    return (
      (rows[0] as {
        first_touch: AttributionTouch | null;
        last_touch: AttributionTouch | null;
        created_at: string;
      } | undefined) ?? null
    );
  } catch {
    return null;
  }
}
