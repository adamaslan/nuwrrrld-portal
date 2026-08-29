/**
 * Durable store for express ToS / Privacy Policy consent events. Same
 * degrade-don't-fail shape as lib/disclaimer-db.ts.
 *
 * recordLegalConsent() fails OPEN — a lost write is re-attempted on the user's
 * next authenticated request via the client gate. hasCurrentLegalConsent()
 * fails CLOSED (returns false → the gate re-prompts) because an outage must not
 * let a user through without a recorded agreement.
 */
import sql from "@/lib/db";
import { LEGAL_DOC_VERSIONS, type LegalDoc } from "@/lib/shared/legal-consent";

export async function recordLegalConsent(
  userId: string,
  doc: LegalDoc,
  version: string,
  meta?: { ip?: string; userAgent?: string; surface?: string },
): Promise<void> {
  try {
    await sql`
      INSERT INTO legal_consent_events (user_id, doc, doc_version, ip, user_agent, surface)
      VALUES (
        ${userId},
        ${doc},
        ${version},
        ${meta?.ip ?? null},
        ${meta?.userAgent ?? null},
        ${meta?.surface ?? "web"}
      )
      ON CONFLICT (user_id, doc, doc_version) DO NOTHING
    `;
  } catch {
    // non-fatal — the client gate retries on the next authenticated request
  }
}

/** True only if the user has accepted the CURRENT version of every legal doc. */
export async function hasCurrentLegalConsent(userId: string): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT doc, doc_version FROM legal_consent_events
      WHERE user_id = ${userId}
    `;
    const accepted = new Map<string, Set<string>>();
    for (const r of rows as Array<{ doc: string; doc_version: string }>) {
      if (!accepted.has(r.doc)) accepted.set(r.doc, new Set());
      accepted.get(r.doc)!.add(r.doc_version);
    }
    return (Object.entries(LEGAL_DOC_VERSIONS) as Array<[LegalDoc, string]>).every(
      ([doc, version]) => accepted.get(doc)?.has(version),
    );
  } catch {
    return false;
  }
}

export async function listLegalConsent(
  userId: string,
): Promise<Array<{ doc: string; doc_version: string; accepted_at: string }>> {
  try {
    const rows = await sql`
      SELECT doc, doc_version, accepted_at FROM legal_consent_events
      WHERE user_id = ${userId}
      ORDER BY accepted_at DESC
    `;
    return rows as Array<{ doc: string; doc_version: string; accepted_at: string }>;
  } catch {
    return [];
  }
}
