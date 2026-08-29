/**
 * Right-to-erasure endpoint (GDPR Art. 17 / CCPA). Two-step by design — a
 * single unauthenticated-looking call must never wipe an account:
 *
 *   POST /api/privacy/delete { confirm: false }  → returns exactly what would be
 *        deleted (row counts per table) plus a one-time `token`. Nothing is
 *        touched. This is the confirmation gate.
 *   POST /api/privacy/delete { confirm: true, token }  → performs the cascade.
 *
 * The token is an HMAC over the userId + a coarse time bucket, so it is only
 * valid for the same signed-in user within ~15 minutes and cannot be forged
 * without PORTAL_PUSH_SECRET. Clerk account deletion and Stripe customer
 * handling are intentionally NOT done here — Stripe billing records carry a
 * 7-year statutory retention (see docs/todo-auth-cookies-tracking.md §5.3);
 * the Clerk user is deleted last, only after the DB cascade succeeds.
 */
import { auth, clerkClient } from "@clerk/nextjs/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db";
import { logPrivacyRequest } from "@/lib/privacy-requests-db";

// Every table that stores rows keyed by Clerk userId. Keep this list in sync
// with lib/db/schema.sql — a missed table is an incomplete erasure.
// council_messages and council_verdicts are NOT listed: both reference
// council_sessions(id) ON DELETE CASCADE, so deleting the sessions rows removes
// them. Neither table has its own user_id column.
const USER_TABLES = [
  "council_sessions",
  "council_usage",
  "nuai_usage",
  "watchlist_items",
  "disclaimer_acks",
  "user_digest_cache",
  "consent_records",
  "legal_consent_events",
] as const;

const TOKEN_WINDOW_MS = 15 * 60 * 1000;

function tokenFor(userId: string, bucket: number): string {
  const secret = process.env.PORTAL_PUSH_SECRET ?? "";
  return createHmac("sha256", secret).update(`${userId}:${bucket}`).digest("hex");
}

function tokenValid(userId: string, token: string): boolean {
  const now = Date.now();
  for (const bucket of [Math.floor(now / TOKEN_WINDOW_MS), Math.floor(now / TOKEN_WINDOW_MS) - 1]) {
    const expected = tokenFor(userId, bucket);
    if (
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected))
    ) {
      return true;
    }
  }
  return false;
}

async function countRows(table: string, userId: string): Promise<number> {
  try {
    const rows = await sql.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [
      userId,
    ]);
    return (rows[0] as { n: number } | undefined)?.n ?? 0;
  } catch {
    return 0;
  }
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const body: unknown = await req.json().catch(() => ({}));
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const confirm = o.confirm === true;

  // Step 1 — dry run. Report the blast radius and hand back a token.
  if (!confirm) {
    const counts: Record<string, number> = {};
    for (const t of USER_TABLES) counts[t] = await countRows(t, userId);
    // Ledger the request at first ask, not at execution — the statutory clock
    // starts when the user asks, even if they never confirm.
    const hdrs0 = await headers();
    await logPrivacyRequest({
      userId,
      kind: "delete",
      status: "received",
      details: { stage: "dry_run", will_delete: counts },
      ip: hdrs0.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: hdrs0.get("user-agent"),
    });
    return NextResponse.json({
      confirm_required: true,
      token: tokenFor(userId, Math.floor(Date.now() / TOKEN_WINDOW_MS)),
      token_expires_in_seconds: TOKEN_WINDOW_MS / 1000,
      will_delete: counts,
      not_deleted: {
        stripe: "billing records retained ~7 years for tax/legal compliance",
        clerk_account: "deleted only after the database cascade succeeds",
      },
    });
  }

  // Step 2 — execute. Requires a valid, recent token for THIS user.
  const token = typeof o.token === "string" ? o.token : "";
  if (!tokenValid(userId, token)) {
    return NextResponse.json(
      { error: "invalid_or_expired_token", hint: "re-request with { confirm: false }" },
      { status: 400 },
    );
  }

  // Ledger BEFORE the cascade. privacy_requests is deliberately not in
  // USER_TABLES, so this row survives the erasure it records.
  const hdrs1 = await headers();
  await logPrivacyRequest({
    userId,
    kind: "delete",
    status: "fulfilled",
    details: { stage: "executed" },
    ip: hdrs1.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs1.get("user-agent"),
  });

  const deleted: Record<string, number | string> = {};
  for (const t of USER_TABLES) {
    try {
      // Count first — a bare DELETE returns no rows, so this is how we report
      // the erasure size back to the user.
      const n = await countRows(t, userId);
      await sql.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
      deleted[t] = n;
    } catch (e) {
      deleted[t] = `error: ${e instanceof Error ? e.message : "unknown"}`;
    }
  }

  // Clerk account last — only reached if the loop above didn't throw out.
  let clerkDeleted = false;
  try {
    const client = await clerkClient();
    await client.users.deleteUser(userId);
    clerkDeleted = true;
  } catch (e) {
    deleted["_clerk_error"] = e instanceof Error ? e.message : "unknown";
  }

  const hdrs = await headers();
  // Best-effort audit line; consent_records itself is now gone, so log to stdout.
  console.info(
    "privacy.delete completed user_id=%s clerk_deleted=%s ua=%s",
    userId,
    clerkDeleted,
    hdrs.get("user-agent") ?? "-",
  );

  return NextResponse.json({ ok: true, clerk_account_deleted: clerkDeleted, deleted });
}
