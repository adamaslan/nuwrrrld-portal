/**
 * Durable disclaimer acknowledgement store for signed-in users. Same
 * degrade-don't-fail shape as lib/holdfold-cache-db.ts: every function is
 * try/catch guarded so a DB outage or un-migrated table degrades gracefully.
 *
 * Unlike most caches in this repo, the failure mode here is deliberately
 * asymmetric: hasAcknowledged() fails CLOSED (returns false → modal re-shows)
 * because an outage must never silently ungate trade-shaped output. recordAck()
 * fails open (swallows the error) because losing one ack write just means the
 * modal shows again next time — annoying, not unsafe.
 */
import sql from "@/lib/db";

export async function hasAcknowledged(userId: string, hash: string): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT 1 FROM disclaimer_acks
      WHERE user_id = ${userId} AND disclaimer_hash = ${hash}
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function recordAck(userId: string, hash: string, version: string, surface?: string): Promise<void> {
  try {
    await sql`
      INSERT INTO disclaimer_acks (user_id, disclaimer_hash, version, surface)
      VALUES (${userId}, ${hash}, ${version}, ${surface ?? null})
      ON CONFLICT (user_id, disclaimer_hash) DO NOTHING
    `;
  } catch {
    // non-fatal — localStorage still gates the client for this session
  }
}
