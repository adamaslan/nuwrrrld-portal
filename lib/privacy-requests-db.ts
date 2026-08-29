/**
 * The data-subject request ledger (docs/todo-auth-cookies-tracking.md Phase 6).
 *
 * One row per DSAR at receipt, so the statutory response clock is provable:
 * GDPR Art. 12(3) = 30 days, CCPA = 45 days. `logPrivacyRequest()` is called
 * by every /api/privacy/* route; it is best-effort — a ledger write failing
 * must never block the user's actual request (an export that returns the data
 * but fails to log is still a served request; the reverse is not true).
 *
 * Mirrors the fail-open write posture of lib/consent-db.ts and
 * lib/disclaimer-db.ts.
 */
import sql from "@/lib/db";

export type PrivacyRequestKind = "export" | "delete" | "rectify";
export type PrivacyRequestStatus =
  | "received"
  | "fulfilled"
  | "in_progress"
  | "rejected";

// GDPR's 30 days is the tighter of the two clocks — track against it.
const STATUTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

interface LogArgs {
  userId: string;
  kind: PrivacyRequestKind;
  status?: PrivacyRequestStatus;
  details?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append one request to the ledger. Returns the new row id, or null if the
 * write failed (caller ignores the return — this is fire-and-log).
 */
export async function logPrivacyRequest({
  userId,
  kind,
  status = "received",
  details,
  ip,
  userAgent,
}: LogArgs): Promise<number | null> {
  try {
    const dueAt = new Date(Date.now() + STATUTORY_WINDOW_MS).toISOString();
    const rows = await sql.query(
      `INSERT INTO privacy_requests (user_id, kind, status, details, due_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        userId,
        kind,
        status,
        details ? JSON.stringify(details) : null,
        dueAt,
        ip ?? null,
        userAgent ?? null,
      ],
    );
    return (rows[0] as { id: number } | undefined)?.id ?? null;
  } catch (err) {
    console.error(
      "privacy_requests ledger write failed user_id=%s kind=%s err=%s",
      userId,
      kind,
      err instanceof Error ? err.message : "unknown",
    );
    return null;
  }
}

/**
 * Mark a previously-logged request resolved. Used by the rectify flow once an
 * operator (or an automated correction) has actioned it. No-op on failure.
 */
export async function resolvePrivacyRequest(
  id: number,
  status: Exclude<PrivacyRequestStatus, "received">,
): Promise<void> {
  try {
    await sql.query(
      `UPDATE privacy_requests SET status = $2, resolved_at = now() WHERE id = $1`,
      [id, status],
    );
  } catch (err) {
    console.error(
      "privacy_requests resolve failed id=%d err=%s",
      id,
      err instanceof Error ? err.message : "unknown",
    );
  }
}

/** A user's own request history — surfaced by GET /api/privacy/profile. */
export async function listPrivacyRequests(
  userId: string,
): Promise<
  Array<{
    id: number;
    kind: PrivacyRequestKind;
    status: PrivacyRequestStatus;
    received_at: string;
    due_at: string;
    resolved_at: string | null;
  }>
> {
  try {
    const rows = await sql.query(
      `SELECT id, kind, status, received_at, due_at, resolved_at
       FROM privacy_requests WHERE user_id = $1 ORDER BY received_at DESC`,
      [userId],
    );
    return rows as Array<{
      id: number;
      kind: PrivacyRequestKind;
      status: PrivacyRequestStatus;
      received_at: string;
      due_at: string;
      resolved_at: string | null;
    }>;
  } catch {
    return [];
  }
}
