/**
 * Durable consent record store for signed-in users. Same degrade-don't-fail
 * shape as lib/disclaimer-db.ts: every function is try/catch guarded so a DB
 * outage or un-migrated table degrades gracefully.
 *
 * Unlike most caches in this repo, the failure mode here is deliberately
 * asymmetric: insertConsentRecord() fails OPEN (swallows the error) because
 * losing one write just means the cookie is the only copy. getLatestConsentRecord()
 * fails CLOSED (returns null) because an outage must not grant a category the
 * user never chose.
 */

import sql from "@/lib/db";
import { parseConsent, type ConsentRecord } from "@/lib/shared/consent";

export async function insertConsentRecord(
  userId: string,
  record: ConsentRecord,
  meta?: { userAgent?: string; ip?: string },
): Promise<void> {
  try {
    await sql`
      INSERT INTO consent_records (
        user_id,
        consent_version,
        source,
        preferences,
        analytics,
        marketing,
        record,
        user_agent,
        ip
      ) VALUES (
        ${userId},
        ${record.v},
        ${record.source},
        ${record.choices.preferences},
        ${record.choices.analytics},
        ${record.choices.marketing},
        ${JSON.stringify(record)}::jsonb,
        ${meta?.userAgent ?? null},
        ${meta?.ip ?? null}
      )
    `;
  } catch {
    // non-fatal — the cookie is the only copy for this session
  }
}

export async function getLatestConsentRecord(userId: string): Promise<ConsentRecord | null> {
  try {
    const rows = await sql`
      SELECT record FROM consent_records
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as { record: unknown };
    return parseConsent(JSON.stringify(row.record));
  } catch {
    return null;
  }
}

export async function listConsentHistory(
  userId: string,
): Promise<Array<{ record: unknown; created_at: string }>> {
  try {
    const rows = await sql`
      SELECT record, created_at FROM consent_records
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return rows as Array<{ record: unknown; created_at: string }>;
  } catch {
    return [];
  }
}
