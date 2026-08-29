/**
 * Consent API — the single write path for the `nu_consent` first-party cookie.
 *
 * GET  → the caller's current ConsentRecord (cookie for everyone; falls back to
 *        the newest consent_records row for signed-in users whose cookie was
 *        cleared, and re-plants the cookie from it).
 * POST → record a consent CHANGE: set the cookie, and for signed-in users append
 *        a row to consent_records (append-only — never an UPDATE).
 *
 * A GPC / DNT request header always overrides the submitted choices for the
 * analytics + marketing categories (see lib/shared/consent.applyDoNotTrack),
 * because California treats GPC as a binding opt-out.
 */
import { auth } from "@clerk/nextjs/server";
import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  CONSENT_COOKIE,
  CONSENT_COOKIE_MAX_AGE,
  buildConsent,
  parseConsent,
  applyDoNotTrack,
  type ConsentChoices,
  type ConsentRecord,
} from "@/lib/shared/consent";
import { getLatestConsentRecord, insertConsentRecord } from "@/lib/consent-db";

const VALID_SOURCES: ConsentRecord["source"][] = [
  "banner_accept_all",
  "banner_reject_all",
  "preferences",
  "gpc",
  "dnt",
  "default",
];

function cookieOptions() {
  return {
    httpOnly: false, // client tag-gating must read this
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: CONSENT_COOKIE_MAX_AGE,
  };
}

/** GET /api/consent — current consent for the caller. */
export async function GET() {
  const cookieStore = await cookies();
  const fromCookie = parseConsent(cookieStore.get(CONSENT_COOKIE)?.value);
  if (fromCookie) {
    return NextResponse.json({ record: fromCookie });
  }

  // No usable cookie. For signed-in users, recover the last stored choice and
  // re-plant the cookie so the banner doesn't re-prompt someone who already chose.
  const { userId } = await auth();
  if (userId) {
    const fromDb = await getLatestConsentRecord(userId);
    if (fromDb) {
      const res = NextResponse.json({ record: fromDb });
      res.cookies.set(CONSENT_COOKIE, JSON.stringify(fromDb), cookieOptions());
      return res;
    }
  }

  return NextResponse.json({ record: null });
}

/** POST /api/consent — record a consent change. */
export async function POST(req: NextRequest) {
  const body: unknown = await req.json().catch(() => ({}));
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const rawChoices = (typeof o.choices === "object" && o.choices !== null ? o.choices : {}) as Record<
    string,
    unknown
  >;
  const desired: Partial<ConsentChoices> = {
    preferences: rawChoices.preferences === true,
    analytics: rawChoices.analytics === true,
    marketing: rawChoices.marketing === true,
  };

  const source: ConsentRecord["source"] = VALID_SOURCES.includes(
    o.source as ConsentRecord["source"],
  )
    ? (o.source as ConsentRecord["source"])
    : "preferences";

  let record = buildConsent(desired, source);

  // A browser privacy signal wins over whatever was submitted.
  const hdrs = await headers();
  if (hdrs.get("sec-gpc") === "1") {
    record = applyDoNotTrack(record, "gpc");
  } else if (hdrs.get("dnt") === "1") {
    record = applyDoNotTrack(record, "dnt");
  }

  const res = NextResponse.json({ ok: true, record });
  res.cookies.set(CONSENT_COOKIE, JSON.stringify(record), cookieOptions());

  const { userId } = await auth();
  if (userId) {
    const ip =
      hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || hdrs.get("x-real-ip") || undefined;
    await insertConsentRecord(userId, record, {
      userAgent: hdrs.get("user-agent") ?? undefined,
      ip,
    });
  }

  return res;
}
