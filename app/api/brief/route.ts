import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const OR_BASE = "https://openrouter.ai/api/v1";

interface IndexEntry { symbol?: string; price?: number; change_pct?: number }
interface MarketOverview {
  brief?: { summary?: string; market_tone?: string; indices?: Record<string, IndexEntry> }
}

async function fetchMarket(): Promise<MarketOverview | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(`${MCP_URL}/market-overview`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json() as MarketOverview;
  } catch { return null; } finally { clearTimeout(t); }
}

async function fetchHoldFold(): Promise<unknown[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(`${MCP_URL}/holdfold`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const arr = Array.isArray(data) ? data : (Array.isArray(data?.verdicts) ? data.verdicts as unknown[] : []);
    return arr.slice(0, 5);
  } catch { return null; } finally { clearTimeout(t); }
}

function buildBriefPrompt(
  tier: string,
  market: MarketOverview | null,
  verdicts: unknown[] | null,
): string {
  const tone = market?.brief?.market_tone ?? "unknown";
  const summary = market?.brief?.summary ?? "No market summary available.";
  const indices = market?.brief?.indices
    ? Object.entries(market.brief.indices).slice(0, 4).map(([name, idx]) => {
        const chg = idx.change_pct != null ? `${idx.change_pct >= 0 ? "+" : ""}${idx.change_pct.toFixed(2)}%` : "";
        return `${idx.symbol ?? name}: ${idx.price != null ? idx.price.toLocaleString() : "n/a"} ${chg}`;
      }).join(", ")
    : "Index data unavailable";

  const topVerdicts = Array.isArray(verdicts) && verdicts.length > 0
    ? verdicts.map((v: unknown) => {
        const vr = v as Record<string, unknown>;
        return `${vr.ticker ?? "?"}: ${vr.verdict ?? "?"} (${vr.confidenceLabel ?? vr.confidence ?? "?"})`;
      }).join("; ")
    : "No verdicts available";

  return [
    `=== REAL MARKET DATA ===`,
    `Market tone: ${tone}`,
    `Indices: ${indices}`,
    `AI summary: ${summary}`,
    `Top Hold/Fold verdicts: ${topVerdicts}`,
    `User tier: ${tier}`,
    ``,
    `You are Nu AI, a financial information assistant for NuWrrrld Financial.`,
    `Write a personalized 4-sentence morning brief for this ${tier} user.`,
    `Ground every sentence in the EXACT data above — cite specific indices, percentages, or verdicts.`,
    `Format: 1) Market overview 2) Standout verdict or signal 3) Key risk to watch 4) One actionable takeaway.`,
    `Do not give specific buy/sell price targets. This is informational only, not personalised financial advice.`,
  ].join("\n");
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    return NextResponse.json({ error: "upgrade_required", upgradeUrl: "/pricing?source=brief" }, { status: 403 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 503 });

  const [market, verdicts] = await Promise.all([fetchMarket(), fetchHoldFold()]);
  const prompt = buildBriefPrompt(tier, market, verdicts);

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
        "X-Title": "NuWrrrld Financial Daily Brief",
      },
      body: JSON.stringify({
        model: "qwen/qwen3-next-80b-a3b-instruct:free",
        max_tokens: 350,
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
        } finally {
          ctrl2.close();
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
    console.error("Brief error", err);
    return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
  }
}
