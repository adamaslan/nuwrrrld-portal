import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { gradeFromScore, type PortfolioHealth } from "@/lib/portfolio";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-1007181159506.us-central1.run.app";
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { health: PortfolioHealth; expiresAt: number }>();

export async function GET() {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return NextResponse.json(cached.health);

  const token = await getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/api/portfolio/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return NextResponse.json({ error: "upstream error" }, { status: 502 });
    const raw = await res.json() as Record<string, unknown>;
    const score = typeof raw.score === 'number' ? Math.round(raw.score) : 0;
    const health: PortfolioHealth = {
      score,
      grade: gradeFromScore(score),
      factors: Array.isArray(raw.factors) ? raw.factors as PortfolioHealth['factors'] : [],
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      generatedAt: typeof raw.generated_at === 'string' ? raw.generated_at : new Date().toISOString(),
    };
    cache.set(userId, { health, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(health);
  } catch {
    return NextResponse.json({ error: "health check unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
