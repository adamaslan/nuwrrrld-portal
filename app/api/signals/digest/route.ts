import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getOrFetchDigest } from "@/lib/digest-cache";

export async function GET(req: NextRequest) {
  const { userId } = await auth();

  // Allow trusted internal callers (e.g. retention digest-email route) via shared secret.
  // This avoids retention emails silently losing signals when no Clerk session exists.
  const secret = process.env.PORTAL_PUSH_SECRET;
  const isInternal =
    Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;

  if (!userId && !isInternal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Shared cache/fallback chain with the server-rendered signals page — see
  // lib/digest-cache.ts. Internal callers pass no userId, so they skip the
  // per-user cache exactly as before.
  const digest = await getOrFetchDigest(userId);
  if (!digest) {
    return NextResponse.json({ error: "no signals available" }, { status: 503 });
  }
  return NextResponse.json(digest);
}
