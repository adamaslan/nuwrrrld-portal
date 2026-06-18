import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { PORTFOLIO_DISCLAIMER, type OptimizerSuggestion } from "@/lib/portfolio";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-1007181159506.us-central1.run.app";
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { suggestions: OptimizerSuggestion[]; expiresAt: number }>();

export async function GET() {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.suggestions);

  const token = await getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/api/portfolio/suggestions`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return NextResponse.json([]);
    const raw = await res.json() as unknown[];
    const suggestions: OptimizerSuggestion[] = raw.map((s: unknown, i: number) => {
      const r = (s ?? {}) as Record<string, unknown>;
      return {
        id: String(r.id ?? `suggestion-${i}`),
        title: String(r.title ?? ''),
        rationale: String(r.rationale ?? r.reason ?? ''),
        ticker: typeof r.ticker === 'string' ? r.ticker : undefined,
        priority: ['high', 'medium', 'low'].includes(String(r.priority)) ? r.priority as 'high' | 'medium' | 'low' : 'medium',
        disclaimer: PORTFOLIO_DISCLAIMER,
      };
    });
    cache.set(userId, { suggestions, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(suggestions);
  } catch {
    return NextResponse.json([]);
  } finally {
    clearTimeout(timer);
  }
}
