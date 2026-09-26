import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";

/**
 * Bearer PORTAL_PUSH_SECRET guard for the engine's server-to-server routes.
 * Unset secret is a 503 (deployment problem), a wrong one a 401.
 */
export function requirePushSecret(req: NextRequest, tag: string): NextResponse | null {
  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    console.error(`[${tag}] CONFIG_ERROR: PORTAL_PUSH_SECRET is not set`);
    return NextResponse.json({ error: "PORTAL_PUSH_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
