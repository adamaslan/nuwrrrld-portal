/**
 * POST /api/privacy/rectify — GDPR Art. 16 right to rectification.
 *
 * Most user-facing data here is either self-service (watchlist, consent
 * preferences, Clerk profile the user edits directly) or system-derived
 * (usage counts, timestamps) and not correctable by request. This endpoint is
 * for the remainder: a structured correction request against a named field,
 * logged to the DSAR ledger so the statutory 30-day clock is on record and an
 * operator can action it. It does not mutate data directly — a self-serve
 * write that looked like a "rectification" would bypass the audit trail the
 * right is supposed to create.
 *
 * docs/todo-auth-cookies-tracking.md Phase 6.
 */
import { auth, currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { logPrivacyRequest } from "@/lib/privacy-requests-db";

const MAX_FIELD_LEN = 120;
const MAX_VALUE_LEN = 2_000;
const MAX_REASON_LEN = 2_000;

// A correction request is cheap to file and cheap to store, but it opens an
// operator ticket — throttle abusive filing per user.
const LIMIT = 5;
const WINDOW_MS = 60 * 60_000; // 5 / hour

interface RectifyBody {
  field?: unknown;
  current_value?: unknown;
  requested_value?: unknown;
  reason?: unknown;
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const gate = rateLimit(`privacy:rectify:${userId}`, LIMIT, WINDOW_MS);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_seconds: Math.ceil((gate.resetAt - Date.now()) / 1000) },
      { status: 429, headers: { "Retry-After": String(Math.ceil((gate.resetAt - Date.now()) / 1000)) } },
    );
  }

  const raw: unknown = await req.json().catch(() => ({}));
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as RectifyBody;

  const field = str(body.field, MAX_FIELD_LEN);
  const requestedValue = str(body.requested_value, MAX_VALUE_LEN);
  if (!field || !requestedValue) {
    return NextResponse.json(
      { error: "field and requested_value are required (non-empty strings)" },
      { status: 400 },
    );
  }
  const currentValue = str(body.current_value, MAX_VALUE_LEN);
  const reason = str(body.reason, MAX_REASON_LEN);

  const hdrs = await headers();
  const user = await currentUser();

  const id = await logPrivacyRequest({
    userId,
    kind: "rectify",
    status: "received",
    details: {
      field,
      current_value: currentValue,
      requested_value: requestedValue,
      reason,
      contact_email: user?.emailAddresses?.[0]?.emailAddress ?? null,
    },
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });

  return NextResponse.json(
    {
      ok: true,
      request_id: id,
      status: "received",
      statutory_deadline_days: 30,
      note:
        "Your correction request has been logged. If the field is self-editable " +
        "(profile, watchlist, cookie preferences) you can change it directly; " +
        "otherwise an operator will action this within the statutory window.",
    },
    { status: 202 },
  );
}
