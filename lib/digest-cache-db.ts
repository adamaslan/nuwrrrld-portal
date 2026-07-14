import type { DigestPayload } from "@/lib/digest";
import sql from "@/lib/db";

const CACHE_TTL_MINUTES = 15;

export async function getLatestDigest(): Promise<DigestPayload | null> {
  try {
    const rows = await sql`
      SELECT payload, generated_at
      FROM signal_digest_cache
      WHERE generated_at > now() - (${CACHE_TTL_MINUTES} || ' minutes')::interval
      ORDER BY generated_at DESC
      LIMIT 1
    `;
    if (!rows.length) return null;
    return rows[0].payload as DigestPayload;
  } catch {
    return null;
  }
}

export async function saveDigest(digest: DigestPayload): Promise<void> {
  try {
    await sql`
      INSERT INTO signal_digest_cache (period_label, payload, generated_at)
      VALUES (${digest.periodLabel}, ${JSON.stringify(digest)}, ${digest.generatedAt})
    `;
  } catch {
    // non-fatal — in-memory cache still works
  }
}

// ── Per-user digest cache (durable replacement for the in-memory userCache Map) ──
// Every function is try/catch → null/no-op: if the DB is unreachable or the table
// hasn't been migrated yet, callers fall back to their in-memory L1. Safe to deploy
// before `npm run db:migrate` has run.

export async function getUserDigest(userId: string): Promise<DigestPayload | null> {
  try {
    const rows = await sql`
      SELECT payload
      FROM user_digest_cache
      WHERE user_id = ${userId} AND expires_at > now()
      LIMIT 1
    `;
    if (!rows.length) return null;
    return rows[0].payload as DigestPayload;
  } catch {
    return null;
  }
}

export async function saveUserDigest(
  userId: string,
  digest: DigestPayload,
  expiresAt: Date,
): Promise<void> {
  try {
    await sql`
      INSERT INTO user_digest_cache (user_id, payload, expires_at)
      VALUES (${userId}, ${JSON.stringify(digest)}, ${expiresAt.toISOString()})
      ON CONFLICT (user_id)
      DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at
    `;
  } catch {
    // non-fatal — in-memory L1 still works
  }
}
