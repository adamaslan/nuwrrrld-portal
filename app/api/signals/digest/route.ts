export const runtime = 'edge';
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { adaptLiveSignals, type DigestPayload } from "@/lib/digest";
import { globalDigestCache } from "@/lib/digest-cache";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 8_000;

// Per-user in-memory cache — 15 min TTL matches signal freshness.
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { digest: DigestPayload; expiresAt: number }>();

async function fetchLiveSignals(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // GET /signals is public on the GCP3 backend — no auth header needed.
    const res = await fetch(`${MCP_URL}/signals`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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

  // 1. Serve per-user cached digest if still fresh (skip for internal callers).
  const cached = userId ? cache.get(userId) : undefined;
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.digest);
  }

  // 2. Fall back to globally-pushed digest from local refresh script (warm ~1h).
  const GLOBAL_CACHE_TTL_MS = 60 * 60 * 1000;
  if (globalDigestCache.digest && Date.now() - globalDigestCache.pushedAt < GLOBAL_CACHE_TTL_MS) {
    return NextResponse.json(globalDigestCache.digest);
  }

  // 3. Fetch from the live GCP3 /signals endpoint (public, no user token needed).
  const raw = await fetchLiveSignals();
  if (!raw) {
    return NextResponse.json({ error: "no signals available" }, { status: 503 });
  }

  let digest: DigestPayload;
  try {
    digest = adaptLiveSignals(raw);
  } catch {
    return NextResponse.json({ error: "failed to parse signals" }, { status: 502 });
  }

  if (userId) cache.set(userId, { digest, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(digest);
}
