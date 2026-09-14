import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { PORTFOLIO_DISCLAIMER, type OptimizerSuggestion } from "@/lib/portfolio";
import { getWatchlist } from "@/lib/watchlist-store";
import { localPortfolioSuggestions } from "@/lib/portfolio-health-local";

// Same fault as the health route beside it: `{MCP_BACKEND_URL}/api/portfolio/
// suggestions` is not registered on gcp3, so this always 404'd and the
// `catch → []` rendered "No suggestions right now — check back after adding
// tickers" no matter how many tickers were on the watchlist. That message is
// indistinguishable from a genuinely quiet day, which is why it read as
// working. Upstream is still preferred; an empty or failed upstream now falls
// back to suggestions derived from `ticker_cards`.
const MCP_URL = process.env.MCP_BACKEND_URL;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 500;
const cache = new Map<string, { suggestions: OptimizerSuggestion[]; expiresAt: number }>();

function pruneCache() {
  if (cache.size < MAX_CACHE_SIZE) return;
  const now = Date.now();
  for (const [key, val] of cache) {
    if (val.expiresAt < now) cache.delete(key);
  }
  // Expired-only cleanup doesn't bound the Map when every entry is still
  // fresh (a 15-minute TTL limits age, not count) — evict the oldest fresh
  // entry too so a new insert can never push the cache past MAX_CACHE_SIZE.
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}

/** Ask gcp3. `null` (not `[]`) on every failure, so "upstream is down" and
 *  "upstream has nothing to say" stay distinguishable to the caller. */
async function fetchUpstreamSuggestions(token: string): Promise<OptimizerSuggestion[] | null> {
  if (!MCP_URL) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/api/portfolio/suggestions`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[portfolio-suggestions] upstream_status=${res.status}`);
      return null;
    }
    const rawJson: unknown = await res.json();
    if (!Array.isArray(rawJson)) return null;
    const parsed: OptimizerSuggestion[] = [];
    for (let i = 0; i < rawJson.length; i++) {
      const r = (rawJson[i] ?? {}) as Record<string, unknown>;
      // A malformed entry — `{}` most concretely — must not silently become a
      // suggestion with an empty title and rationale. `String(undefined ??
      // "")` never throws, so nothing here would otherwise catch it; its
      // nonzero array length would also prevent the local fallback from ever
      // running, since suggestions.length === 0 is the only trigger for it.
      // Treat any invalid entry as contract drift on the whole response, not
      // a single bad row to drop — a partial upstream answer next to a
      // discarded bad row would be a silent quality drop with nothing to flag it.
      const title = typeof r.title === "string" ? r.title.trim() : "";
      const rationale = typeof r.rationale === "string" ? r.rationale.trim() : typeof r.reason === "string" ? r.reason.trim() : "";
      if (!title || !rationale) {
        console.warn(`[portfolio-suggestions] upstream_contract_drift: entry ${i} missing title/rationale`);
        return null;
      }
      parsed.push({
        id: String(r.id ?? `suggestion-${i}`),
        title,
        rationale,
        ticker: typeof r.ticker === "string" ? r.ticker : undefined,
        priority: ["high", "medium", "low"].includes(String(r.priority))
          ? (r.priority as "high" | "medium" | "low")
          : "medium",
        disclaimer: PORTFOLIO_DISCLAIMER,
      });
    }
    return parsed;
  } catch (err) {
    console.warn(
      `[portfolio-suggestions] upstream_unreachable err=${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  // Read the watchlist before the cache lookup and key on it, the same way
  // the health route beside it does. Keying on `userId` alone served stale
  // suggestions computed for a *previous* watchlist for up to the full
  // 15-minute TTL after any add/remove.
  //
  // A Neon read failure here is not "this user has no watchlist" — collapsing
  // it to [] previously produced a false empty-suggestions result that then
  // got cached for 15 minutes, masking a retriable dependency failure as
  // "nothing to suggest."
  let watchlist;
  try {
    watchlist = await getWatchlist(userId);
  } catch {
    return NextResponse.json({ error: "watchlist_unavailable" }, { status: 503 });
  }
  const tickers = watchlist.map((w) => w.ticker);
  const cacheKey = `${userId}:${[...tickers].sort().join(",")}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.suggestions);

  const token = await getToken().catch(() => null);
  const upstream = token ? await fetchUpstreamSuggestions(token) : null;

  // A successful-but-empty upstream is still worth backfilling from local
  // cards: gcp3 has no per-user portfolio state, so its "nothing" carries no
  // information about *this* watchlist.
  const suggestions = upstream !== null && upstream.length > 0 ? upstream : await localPortfolioSuggestions(tickers);

  pruneCache();
  cache.set(cacheKey, { suggestions, expiresAt: Date.now() + CACHE_TTL_MS });
  return NextResponse.json(suggestions);
}
