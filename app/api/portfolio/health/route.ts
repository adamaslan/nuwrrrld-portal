import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { gradeFromScore, type PortfolioHealth } from "@/lib/portfolio";
import { getWatchlist } from "@/lib/watchlist-store";

// gcp3's /api/portfolio/health is stateless and ticker-keyed (no Clerk token
// sent, none accepted) — the endpoint has no concept of "whose" portfolio it
// is, only "which tickers." We resolve the user's own watchlist from Neon and
// pass it explicitly; see docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md.
// Fail-closed: don't fall back to a hardcoded external host.
const MCP_URL = process.env.MCP_BACKEND_URL;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

// Bounded cache: evict all expired entries when at capacity. Keyed by
// user+ticker-set (not just userId) — a changed watchlist must not serve a
// stale score computed for the previous set of tickers.
const cache = new Map<string, { health: PortfolioHealth; expiresAt: number }>();

function pruneCache() {
  if (cache.size < MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, val] of cache) {
    if (val.expiresAt < now) cache.delete(key);
  }
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!MCP_URL) return NextResponse.json({ error: "MCP_BACKEND_URL not configured" }, { status: 503 });

  const tickers = (await getWatchlist(userId).catch(() => [])).map(w => w.ticker);

  // Empty watchlist: never let gcp3's hardcoded DEFAULT_PORTFOLIO fallback be
  // presented as this user's score. 204 is an unambiguous "nothing to score"
  // signal distinct from every error path below.
  if (tickers.length === 0) return new NextResponse(null, { status: 204 });

  const cacheKey = `${userId}:${[...tickers].sort().join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.health);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(
      `${MCP_URL}/api/portfolio/health?tickers=${encodeURIComponent(tickers.join(","))}`,
      { signal: controller.signal },
    );
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
    cache.set(cacheKey, { health, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(health);
  } catch {
    return NextResponse.json({ error: "health check unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
