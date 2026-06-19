import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { normaliseDigest, type DigestPayload } from "@/lib/digest";
import { globalDigestCache } from "@/app/api/signals/refresh/route";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 8_000;

// Simple in-memory cache — TTL matches signal freshness (15 min).
// Per-user keying keeps portfolios private.
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { digest: DigestPayload; expiresAt: number }>();

async function fetchWithTimeout(url: string, token: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const { userId, getToken } = await auth();
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

  const token = await getToken();
  if (!token) return NextResponse.json({ error: "no token" }, { status: 401 });

  // Fetch from both optimizers in parallel; tolerate individual failures.
  const [raw1, raw2] = await Promise.all([
    fetchWithTimeout(`${MCP_URL}/api/signals/digest`, token),
    fetchWithTimeout(`${MCP_URL}/api/signals/digest/v2`, token),
  ]);

  // Merge signals from both sources; use whichever responded.
  const sources: string[] = [];
  const mergedSignals: unknown[] = [];

  function extractSignals(raw: unknown, sourceId: string) {
    if (!raw || typeof raw !== "object") return;
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.signals)) {
      mergedSignals.push(...r.signals);
      sources.push(sourceId);
    }
  }
  extractSignals(raw1, "ai-fin-opt");
  extractSignals(raw2, "ai-fin-opt2");

  if (mergedSignals.length === 0) {
    return NextResponse.json({ error: "no signals available" }, { status: 503 });
  }

  // Extract periodLabel from whichever raw response provided it.
  const r1 = raw1 as Record<string, unknown> | null;
  const r2 = raw2 as Record<string, unknown> | null;
  const periodLabel = r1?.period_label ?? r1?.periodLabel ?? r2?.period_label ?? r2?.periodLabel ?? '';

  const digest = normaliseDigest(
    { signals: mergedSignals, period_label: periodLabel, generated_at: new Date().toISOString() },
    sources
  );

  cache.set(userId, { digest, expiresAt: Date.now() + CACHE_TTL_MS });

  return NextResponse.json(digest);
}
