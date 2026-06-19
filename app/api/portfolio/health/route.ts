import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { gradeFromScore, type PortfolioHealth } from "@/lib/portfolio";

// Fail-closed: don't fall back to a hardcoded external host with a user token.
const MCP_URL = process.env.MCP_BACKEND_URL;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

// Bounded cache: evict all expired entries when at capacity.
const cache = new Map<string, { health: PortfolioHealth; expiresAt: number }>();

function pruneCache() {
  if (cache.size < MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, val] of cache) {
    if (val.expiresAt < now) cache.delete(key);
  }
}

export async function GET() {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!MCP_URL) return NextResponse.json({ error: "MCP_BACKEND_URL not configured" }, { status: 503 });

  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.health);

  const token = await getToken();
  if (!token) return NextResponse.json({ error: "no token" }, { status: 401 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/api/portfolio/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return NextResponse.json({ error: "upstream error" }, { status: 502 });
    const raw = await res.json();
    const data = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};
    const score = typeof data.score === 'number' ? Math.round(data.score) : 0;
    const health: PortfolioHealth = {
      score,
      grade: gradeFromScore(score),
      factors: Array.isArray(data.factors) ? data.factors as PortfolioHealth['factors'] : [],
      summary: typeof data.summary === 'string' ? data.summary : '',
      generatedAt: typeof data.generated_at === 'string' ? data.generated_at : new Date().toISOString(),
    };
    pruneCache();
    cache.set(userId, { health, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(health);
  } catch {
    return NextResponse.json({ error: "health check unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
