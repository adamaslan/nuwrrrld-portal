import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { adaptLiveSignals, type DigestPayload } from "@/lib/digest";
import { globalDigestCache } from "@/app/api/signals/refresh/route";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 8_000;

// Simple in-memory cache — TTL matches signal freshness (15 min).
// Per-user keying keeps portfolios private.
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { digest: DigestPayload; expiresAt: number }>();

async function fetchLiveSignals(): Promise<DigestPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals`, {
      signal: controller.signal,
      next: { revalidate: 900 },
    });
    if (!res.ok) return null;
    return adaptLiveSignals(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  // 1. Return per-user cached digest if still fresh.
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.digest);
  }

  // 2. Fall back to globally-pushed digest from local refresh script (warm ~1h).
  const GLOBAL_CACHE_TTL_MS = 60 * 60 * 1000;
  if (globalDigestCache.digest && (Date.now() - globalDigestCache.pushedAt) < GLOBAL_CACHE_TTL_MS) {
    return NextResponse.json(globalDigestCache.digest);
  }

  const digest = await fetchLiveSignals();
  if (!digest) return NextResponse.json({ error: "no signals available" }, { status: 503 });

  cache.set(userId, { digest, expiresAt: Date.now() + CACHE_TTL_MS });

  return NextResponse.json(digest);
}
