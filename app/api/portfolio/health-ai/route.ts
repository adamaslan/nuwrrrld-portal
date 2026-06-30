import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { store } from "@/lib/watchlist-store";
import type { PortfolioHealth } from "@/lib/portfolio";
import { gradeFromScore } from "@/lib/portfolio";

const MCP_URL = process.env.MCP_BACKEND_URL;
const OR_BASE = "https://openrouter.ai/api/v1";

async function fetchHealth(userId: string, token: string): Promise<PortfolioHealth | null> {
  if (!MCP_URL) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7_000);
  try {
    const res = await fetch(`${MCP_URL}/api/portfolio/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const raw = await res.json() as Record<string, unknown>;
    const score = typeof raw.score === "number" ? Math.round(raw.score) : 0;
    const grade = gradeFromScore(score);
    return {
      score,
      grade,
      factors: Array.isArray(raw.factors) ? raw.factors as PortfolioHealth["factors"] : [],
      summary: typeof raw.summary === "string" ? raw.summary : "",
      generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : new Date().toISOString(),
    };
  } catch { return null; } finally { clearTimeout(t); }
  void userId;
}

function buildHealthPrompt(
  watchlist: string[],
  health: PortfolioHealth | null,
): string {
  const lines = [
    `=== REAL PORTFOLIO DATA ===`,
    `Watchlist tickers: ${watchlist.length > 0 ? watchlist.join(", ") : "none added yet"}`,
  ];

  if (health) {
    lines.push(
      `Portfolio health score: ${health.score}/100 (Grade ${health.grade})`,
      `Health summary: ${health.summary}`,
    );
    if (health.factors.length > 0) {
      lines.push(
        `Factor breakdown:`,
        ...health.factors.map(f => `  - ${f.name}: ${f.score}/100 (${f.impact}) — ${f.description}`),
      );
    }
  } else {
    lines.push(`Portfolio health data: unavailable (no GCP3 backend connection)`);
  }

  lines.push(
    ``,
    `Using ONLY the exact data above, provide a portfolio health check.`,
    `Deliver: 1) Overall assessment (A–F grade with explanation) 2) Biggest risk factor 3) One specific, grounded rebalancing suggestion based on the actual tickers and factors shown.`,
    `Be concise (~180 words). Cite specific numbers. This is informational only, not personalised financial advice.`,
  );

  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  void req;
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    return NextResponse.json({ error: "upgrade_required", upgradeUrl: "/pricing?source=portfolio" }, { status: 403 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 503 });

  const watchlist = (store.get(userId) ?? []).map(i => i.ticker);
  const token = await getToken().catch(() => null);
  const health = token ? await fetchHealth(userId, token) : null;
  const prompt = buildHealthPrompt(watchlist, health);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);

  try {
    const response = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://financial.nuwrrrld.com",
        "X-Title": "NuWrrrld Financial Portfolio Health Check",
      },
      body: JSON.stringify({
        model: "cohere/command-r7b-12-2024",
        max_tokens: 400,
        stream: true,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      clearTimeout(timer);
      return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
    }

    const upstream = response.body!;
    const decoder = new TextDecoder();
    const enc = new TextEncoder();
    const reader = upstream.getReader();

    const stream = new ReadableStream({
      async start(ctrl2) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            ctrl2.enqueue(enc.encode(decoder.decode(value, { stream: true })));
          }
          ctrl2.close();
        } catch (err) {
          ctrl2.error(err);
        } finally {
          clearTimeout(timer);
        }
      },
      cancel() {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
        ctrl.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    clearTimeout(timer);
    console.error("Health AI error", err);
    return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
  }
}
