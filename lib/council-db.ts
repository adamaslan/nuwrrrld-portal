/**
 * Council persistence — sessions, messages, verdicts, and the daily deliberation
 * quota, backed by the WS1 Neon schema (lib/db/schema.sql).
 *
 * Every function is try/catch guarded: if the DB is unreachable or unmigrated, a
 * deliberation still runs and returns to the user — it just isn't persisted and
 * the quota isn't enforced. Persistence is a durability feature, not a hard
 * dependency of the request path.
 */
import sql from "@/lib/db";
import type { CouncilSeat } from "@/lib/openrouter";

export interface CouncilVerdict {
  direction: "bullish" | "bearish" | "neutral" | null;
  confidence: "low" | "medium" | "high" | null;
  horizon: string | null;
  invalidation: string | null;
}

export async function createSession(userId: string, topic: string): Promise<string | null> {
  try {
    const rows = await sql`
      INSERT INTO council_sessions (user_id, topic)
      VALUES (${userId}, ${topic})
      RETURNING id
    `;
    return (rows[0]?.id as string) ?? null;
  } catch {
    return null;
  }
}

export async function saveMessage(
  sessionId: string,
  msg: {
    seat: CouncilSeat;
    round: number;
    role: "answer" | "critique" | "synthesis";
    model: string;
    content: string;
    latencyMs?: number;
  },
): Promise<void> {
  if (!sessionId) return;
  try {
    await sql`
      INSERT INTO council_messages (session_id, seat, round, role, model, content, latency_ms)
      VALUES (${sessionId}, ${msg.seat}, ${msg.round}, ${msg.role}, ${msg.model},
              ${msg.content}, ${msg.latencyMs ?? null})
    `;
  } catch {
    /* non-fatal */
  }
}

export async function saveVerdict(
  sessionId: string,
  ticker: string | null,
  v: CouncilVerdict,
): Promise<void> {
  if (!sessionId) return;
  try {
    await sql`
      INSERT INTO council_verdicts (session_id, ticker, direction, confidence, horizon, invalidation)
      VALUES (${sessionId}, ${ticker}, ${v.direction}, ${v.confidence}, ${v.horizon}, ${v.invalidation})
    `;
  } catch {
    /* non-fatal */
  }
}

/** Recent verdicts for a ticker — fed back into grounding so the council can
 *  confront its own record ("we were bullish here on <date> and were wrong"). */
export async function recentVerdicts(
  ticker: string,
  limit = 3,
): Promise<Array<CouncilVerdict & { createdAt: string }>> {
  try {
    const rows = await sql`
      SELECT direction, confidence, horizon, invalidation, created_at
      FROM council_verdicts
      WHERE ticker = ${ticker}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      direction: r.direction,
      confidence: r.confidence,
      horizon: r.horizon,
      invalidation: r.invalidation,
      createdAt: (r.created_at as Date | string).toString(),
    }));
  } catch {
    return [];
  }
}

/**
 * Daily deliberation quota (WS2.6). Returns whether the user may run another
 * deliberation today and, if so, records it. Fails OPEN: if the DB is
 * unreachable the user is allowed through (we don't block product on a quota
 * table being down). Returns { allowed, used, limit }.
 */
export async function checkAndBumpQuota(
  userId: string,
  dailyLimit: number,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  try {
    const rows = await sql`
      INSERT INTO council_usage (user_id, usage_date, deliberations)
      VALUES (${userId}, CURRENT_DATE, 1)
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET deliberations = council_usage.deliberations + 1
      RETURNING deliberations
    `;
    const used = (rows[0]?.deliberations as number) ?? 1;
    if (used > dailyLimit) {
      // Over limit — roll the increment back so a blocked attempt doesn't consume quota.
      await sql`
        UPDATE council_usage SET deliberations = deliberations - 1
        WHERE user_id = ${userId} AND usage_date = CURRENT_DATE
      `;
      return { allowed: false, used: used - 1, limit: dailyLimit };
    }
    return { allowed: true, used, limit: dailyLimit };
  } catch {
    return { allowed: true, used: 0, limit: dailyLimit };
  }
}
