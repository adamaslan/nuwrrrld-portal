/**
 * POST /api/signals/refresh
 * Accepts a pre-computed DigestPayload from the local refresh-signals.py script
 * and warms the in-process per-user cache for all active subscribers.
 *
 * Auth: Bearer PORTAL_PUSH_SECRET (server-to-server, not user-facing)
 */
import { NextRequest, NextResponse } from "next/server";
import { normaliseDigest, type DigestPayload } from "@/lib/digest";
import { globalDigestCache } from "@/lib/digest-cache";
import { saveDigest } from "@/lib/digest-cache-db";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.PORTAL_PUSH_SECRET;

  // If no secret is configured, block all pushes to prevent unauthorized cache poisoning.
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  let digest: DigestPayload;
  try {
    digest = normaliseDigest(raw, (raw as Record<string, unknown>).sources as string[] ?? ["local"]);
  } catch (err) {
    return NextResponse.json({ error: `invalid digest: ${err}` }, { status: 422 });
  }

  globalDigestCache.digest = digest;
  globalDigestCache.pushedAt = Date.now();
  // Durable: survives serverless cold starts and is shared across instances.
  // try/catch inside saveDigest → non-fatal if the DB is unreachable.
  await saveDigest(digest);

  console.log(`[signals/refresh] cached ${digest.signals.length} signals from local push`);
  return NextResponse.json({ cached: true, signals: digest.signals.length, generatedAt: digest.generatedAt });
}

export async function GET() {
  if (!globalDigestCache.digest) {
    return NextResponse.json({ cached: false }, { status: 404 });
  }
  return NextResponse.json({
    cached: true,
    signals: globalDigestCache.digest.signals.length,
    pushedAt: new Date(globalDigestCache.pushedAt).toISOString(),
  });
}
