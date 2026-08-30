/**
 * POST /api/attribution — capture a first-party acquisition touch.
 *
 * docs/todo-auth-cookies-tracking.md Phase 4.1. Entirely first-party: UTM
 * params / click ids / referrer the browser already gave us, stored in our own
 * `nu_attrib` cookie. Belongs to the `analytics` consent category, so this
 * route is a no-op unless `nu_consent.analytics === true` (a GPC/DNT header
 * also forces that off, via resolveConsent).
 *
 * Called on landing-page mount with the current URL's query + document.referrer.
 * First-touch is written once and never overwritten; on an authenticated call
 * it also persists first-touch + last-touch to `user_attribution`.
 */
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import {
  ATTRIB_COOKIE,
  ATTRIB_COOKIE_MAX_AGE,
  buildTouch,
  parseTouch,
  serialiseTouch,
} from "@/lib/shared/attribution";
import { readConsentFromRequest, resolveConsent } from "@/lib/consent";
import { ensureUserAttribution } from "@/lib/attribution-db";

function attribCookieOptions() {
  return {
    // Not HttpOnly, mirroring nu_consent: there is no secret in here, and a
    // client-side tag may need to read the acquisition source.
    httpOnly: false as const,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ATTRIB_COOKIE_MAX_AGE,
  };
}

export async function POST(req: NextRequest) {
  const hdrs = await headers();

  // Consent gate. No analytics consent → do nothing at all, return 204.
  const consent = resolveConsent(readConsentFromRequest(req), hdrs);
  if (!consent?.choices.analytics) {
    return new NextResponse(null, { status: 204 });
  }

  const body: unknown = await req.json().catch(() => ({}));
  const o = (typeof body === "object" && body !== null ? body : {}) as {
    query?: unknown;
    referrer?: unknown;
    landing_path?: unknown;
  };

  const query = typeof o.query === "string" ? o.query : "";
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const currentTouch = buildTouch(params, {
    referrer: typeof o.referrer === "string" ? o.referrer : null,
    landingPath: typeof o.landing_path === "string" ? o.landing_path : null,
    selfHost: req.nextUrl.host,
  });

  const existingFirst = parseTouch(req.cookies.get(ATTRIB_COOKIE)?.value);

  const res = NextResponse.json({
    ok: true,
    first_touch: existingFirst ?? currentTouch,
    captured: currentTouch !== null,
  });

  // Set the first-touch cookie only if we don't already have one and there is
  // something worth attributing about this visit.
  if (!existingFirst && currentTouch) {
    res.cookies.set(ATTRIB_COOKIE, serialiseTouch(currentTouch), attribCookieOptions());
  }

  const { userId } = await auth();
  if (userId) {
    await ensureUserAttribution(userId, existingFirst ?? currentTouch, currentTouch);
  }

  return res;
}
