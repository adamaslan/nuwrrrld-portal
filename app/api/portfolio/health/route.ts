import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { gradeFromScore, type PortfolioHealth } from "@/lib/portfolio";
import { getWatchlist } from "@/lib/watchlist-store";
import { localPortfolioHealth } from "@/lib/portfolio-health-local";

// gcp3's /api/portfolio/health is stateless and ticker-keyed (no Clerk token
// sent, none accepted) — the endpoint has no concept of "whose" portfolio it
// is, only "which tickers." We resolve the user's own watchlist from Neon and
// pass it explicitly; see docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md.
//
// That upstream route has never actually been deployed: gcp3's live OpenAPI
// registers no portfolio path at all, so this call 404s and the panel showed
// "Health score unavailable" permanently. Upstream is still preferred when it
// answers, but a failure now degrades to a score computed from `ticker_cards`
// — portal-owned data that covers the whole registered universe — instead of
// to an error. Only a watchlist with no computed signals at all has no score.
const MCP_URL = process.env.MCP_BACKEND_URL;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

// Above this the `?tickers=` query string stops being a reasonable URL (a
// 980-ticker watchlist is ~5 KB and draws a 414 from most proxies), so a large
// watchlist goes straight to the local path rather than burning 8s on a
// request that cannot succeed.
const MAX_UPSTREAM_TICKERS = 100;

type HealthSource = "upstream" | "local";

// Bounded cache: evict all expired entries when at capacity. Keyed by
// user+ticker-set (not just userId) — a changed watchlist must not serve a
// stale score computed for the previous set of tickers.
const cache = new Map<string, { health: PortfolioHealth; source: HealthSource; expiresAt: number }>();

function pruneCache() {
  if (cache.size < MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, val] of cache) {
    if (val.expiresAt < now) cache.delete(key);
  }
}

function respond(health: PortfolioHealth, source: HealthSource) {
  // The client renders a provenance note from this. Three distinct faults
  // (bad env var, missing route, upstream 5xx) previously rendered one
  // identical string, which is what made the outage take 11 days to find.
  return NextResponse.json(health, { headers: { "X-Portfolio-Health-Source": source } });
}

/**
 * Ask gcp3. Returns null on every failure mode — unreachable, non-2xx, and
 * (critically) a 200 carrying a payload that is not this contract.
 *
 * That last case is not defensive padding. gcp3's analyzer emits
 * `ai_grade`/`ai_insights` with no numeric `score`, and the previous
 * `typeof raw.score === 'number' ? … : 0` coercion turned that drift into
 * "score 0, Grade F" for every user — a wrong answer that looks like a real
 * one. Treating it as a miss routes it to the local path instead.
 */
async function fetchUpstreamHealth(tickers: string[]): Promise<PortfolioHealth | null> {
  if (!MCP_URL || tickers.length > MAX_UPSTREAM_TICKERS) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(
      `${MCP_URL}/api/portfolio/health?tickers=${encodeURIComponent(tickers.join(","))}`,
      { signal: controller.signal },
    );
    if (!res.ok) {
      console.warn(`[portfolio-health] upstream_status=${res.status} tickers=${tickers.length}`);
      return null;
    }
    const raw: unknown = await res.json();
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (typeof data.score !== "number" || !Number.isFinite(data.score)) {
      console.warn("[portfolio-health] upstream_contract_drift: no numeric `score` in 200 response");
      return null;
    }
    const score = Math.round(data.score);
    return {
      score,
      grade: gradeFromScore(score),
      factors: Array.isArray(data.factors) ? (data.factors as PortfolioHealth["factors"]) : [],
      summary: typeof data.summary === "string" ? data.summary : "",
      generatedAt:
        typeof data.generated_at === "string" ? data.generated_at : new Date().toISOString(),
    };
  } catch (err) {
    console.warn(
      `[portfolio-health] upstream_unreachable err=${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const tickers = (await getWatchlist(userId).catch(() => [])).map((w) => w.ticker);

  // Empty watchlist: never let gcp3's hardcoded DEFAULT_PORTFOLIO fallback be
  // presented as this user's score. 204 is an unambiguous "nothing to score"
  // signal distinct from every error path below.
  if (tickers.length === 0) return new NextResponse(null, { status: 204 });

  const cacheKey = `${userId}:${[...tickers].sort().join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return respond(cached.health, cached.source);

  const upstream = await fetchUpstreamHealth(tickers);
  const health = upstream ?? (await localPortfolioHealth(tickers));
  const source: HealthSource = upstream ? "upstream" : "local";

  // The terminal honest state: upstream is down AND not one watchlist ticker
  // has a computed signal. There is genuinely no score to give.
  if (!health) {
    return NextResponse.json(
      { error: "no signals computed for this watchlist yet" },
      { status: 503, headers: { "X-Portfolio-Health-Source": "local" } },
    );
  }

  pruneCache();
  cache.set(cacheKey, { health, source, expiresAt: Date.now() + CACHE_TTL_MS });
  return respond(health, source);
}
