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
