/**
 * GET /api/privacy/export — GDPR Art. 15 data subject access request (SAR).
 * Assembles a JSON export of all user data keyed by the authenticated user.
 * Each query is independent; failures degrade to empty/null with errors tracked.
 * Returns the payload with Content-Disposition attachment header.
 *
 * TODO(privacy): add a per-user rate limit (e.g. 3/hour) — deferred to the
 * analytics PR which introduces the limiter.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import sql from "@/lib/db";

interface ExportPayload {
  generated_at: string;
  user_id: string;
  clerk: {
    email?: string;
    created_at?: string;
    public_metadata?: Record<string, unknown>;
  } | null;
  council_sessions: unknown[];
  council_messages: unknown[];
  council_usage: unknown[];
  nuai_usage: unknown[];
  watchlist_items: unknown[];
  disclaimer_acks: unknown[];
  user_digest_cache: unknown | null;
  consent_records: unknown[];
  legal_consent_events: unknown[];
  _errors: string[];
}

/**
 * `_errors` ships to the client inside the export file, so a raw Postgres
 * message would disclose schema names, column lists, and fragments of the
 * failing query to anyone who can trigger the failure. The user only needs to
 * know that a section is incomplete; the detail belongs in the server log.
 */
function describeExportError(err: unknown): string {
  console.error("[privacy-export] section query failed:", err);
  return "unavailable";
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();

  const payload: ExportPayload = {
    generated_at: new Date().toISOString(),
    user_id: userId,
    clerk: user
      ? {
          email: user.emailAddresses?.[0]?.emailAddress,
          created_at:
            user.createdAt && typeof user.createdAt === "object" && "toISOString" in user.createdAt
              ? (user.createdAt as { toISOString(): string }).toISOString()
              : undefined,
          public_metadata: user.publicMetadata as Record<string, unknown>,
        }
      : null,
    council_sessions: [],
    council_messages: [],
    council_usage: [],
    nuai_usage: [],
    watchlist_items: [],
    disclaimer_acks: [],
    user_digest_cache: null,
    consent_records: [],
    legal_consent_events: [],
    _errors: [],
  };

  // council_sessions
  try {
    const sessions = await sql`
      SELECT * FROM council_sessions WHERE user_id = ${userId} ORDER BY created_at DESC
    `;
    payload.council_sessions = sessions;
  } catch (err) {
    payload._errors.push(
      `council_sessions: ${describeExportError(err)}`,
    );
  }

  // council_messages (JOIN with council_sessions)
  try {
    const messages = await sql`
      SELECT m.* FROM council_messages m
      INNER JOIN council_sessions s ON m.session_id = s.id
      WHERE s.user_id = ${userId}
      ORDER BY m.created_at DESC
    `;
    payload.council_messages = messages;
  } catch (err) {
    payload._errors.push(
      `council_messages: ${describeExportError(err)}`,
    );
  }

  // council_usage
  try {
    const usage = await sql`
      SELECT * FROM council_usage WHERE user_id = ${userId} ORDER BY usage_date DESC
    `;
    payload.council_usage = usage;
  } catch (err) {
    payload._errors.push(
      `council_usage: ${describeExportError(err)}`,
    );
  }

  // nuai_usage
  try {
    const usage = await sql`
      SELECT * FROM nuai_usage WHERE user_id = ${userId} ORDER BY usage_date DESC
    `;
    payload.nuai_usage = usage;
  } catch (err) {
    payload._errors.push(
      `nuai_usage: ${describeExportError(err)}`,
    );
  }

  // watchlist_items
  try {
    const items = await sql`
      SELECT * FROM watchlist_items WHERE user_id = ${userId} ORDER BY added_at DESC
    `;
    payload.watchlist_items = items;
  } catch (err) {
    payload._errors.push(
      `watchlist_items: ${describeExportError(err)}`,
    );
  }

  // disclaimer_acks
  try {
    const acks = await sql`
      SELECT * FROM disclaimer_acks WHERE user_id = ${userId} ORDER BY acknowledged_at DESC
    `;
    payload.disclaimer_acks = acks;
  } catch (err) {
    payload._errors.push(
      `disclaimer_acks: ${describeExportError(err)}`,
    );
  }

  // user_digest_cache (single row or null)
  try {
    const result = await sql`
      SELECT * FROM user_digest_cache WHERE user_id = ${userId}
    `;
    payload.user_digest_cache = result.length > 0 ? result[0] : null;
  } catch (err) {
    payload._errors.push(
      `user_digest_cache: ${describeExportError(err)}`,
    );
  }

  // consent_records
  try {
    const records = await sql`
      SELECT * FROM consent_records WHERE user_id = ${userId} ORDER BY created_at DESC
    `;
    payload.consent_records = records;
  } catch (err) {
    payload._errors.push(
      `consent_records: ${describeExportError(err)}`,
    );
  }

  // legal_consent_events
  try {
    const events = await sql`
      SELECT * FROM legal_consent_events WHERE user_id = ${userId} ORDER BY accepted_at DESC
    `;
    payload.legal_consent_events = events;
  } catch (err) {
    payload._errors.push(
      `legal_consent_events: ${describeExportError(err)}`,
    );
  }

  return NextResponse.json(payload, {
    headers: {
      "Content-Disposition": 'attachment; filename="nuwrrrld-data-export.json"',
      // A full personal-data export must never be written to a browser or
      // intermediary cache where a later visitor on the same device could
      // retrieve it.
      "Cache-Control": "no-store",
    },
  });
}
