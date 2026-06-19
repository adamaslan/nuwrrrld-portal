import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { PORTFOLIO_DISCLAIMER, type OptimizerSuggestion } from "@/lib/portfolio";

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
}

export async function GET() {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!MCP_URL) return NextResponse.json({ error: "MCP_BACKEND_URL not configured" }, { status: 503 });

  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.suggestions);

  const token = await getToken();
  if (!token) return NextResponse.json({ error: "no token" }, { status: 401 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/api/portfolio/suggestions`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return NextResponse.json([]);
    const rawJson = await res.json();
    const rawArray = Array.isArray(rawJson) ? rawJson : [];
    const suggestions: OptimizerSuggestion[] = rawArray.map((s: unknown, i: number) => {
      const r = (s ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id ?? `suggestion-${i}`),
        title: String(r.title ?? ''),
        rationale: String(r.rationale ?? r.reason ?? ''),
        ticker: typeof r.ticker === 'string' ? r.ticker : undefined,
        priority: ['high', 'medium', 'low'].includes(String(r.priority))
          ? r.priority as 'high' | 'medium' | 'low'
          : 'medium',
        disclaimer: PORTFOLIO_DISCLAIMER,
      };
    });
    pruneCache();
    cache.set(userId, { suggestions, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(suggestions);
  } catch {
    return NextResponse.json([]);
  } finally {
    clearTimeout(timer);
  }
}
