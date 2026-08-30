/**
 * Express legal-consent API (Phase 1.4). The sign-up gate calls this once the
 * user has ticked the ToS + Privacy checkbox and Clerk has a session.
 *
 * GET  → { satisfied: boolean } — has the caller accepted the current version
 *        of every legal document? Used by the client gate to decide whether to
 *        show the blocking checkbox.
 * POST → record acceptance of the current versions. Body is ignored beyond an
 *        optional { surface }: the versions come from lib/shared/legal-consent,
 *        never from the client, so a stale or forged version can't be recorded.
 */
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { requiredConsentEvents } from "@/lib/shared/legal-consent";
import { hasCurrentLegalConsent, recordLegalConsent } from "@/lib/legal-consent-db";
import { auditIp } from "@/lib/consent-db";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ satisfied: false });
  const satisfied = await hasCurrentLegalConsent(userId);
  return NextResponse.json({ satisfied });
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body: unknown = await req.json().catch(() => ({}));
  const surface =
    typeof body === "object" && body !== null && "surface" in body && typeof body.surface === "string"
      ? body.surface.slice(0, 16)
      : "web";

  const hdrs = await headers();
  const ip = auditIp(hdrs);
  const userAgent = hdrs.get("user-agent") ?? undefined;

  for (const { doc, version } of requiredConsentEvents()) {
    await recordLegalConsent(userId, doc, version, { ip, userAgent, surface });
  }

  return NextResponse.json({ ok: true });
}
