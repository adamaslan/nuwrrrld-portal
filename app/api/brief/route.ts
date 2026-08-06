import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { fetchWithModelFallback } from "@/lib/openrouter";
import { mapSignalsToHoldFold } from "@/lib/shared/holdfold-map";
import type { HoldFoldVerdict } from "@/lib/shared/holdfold-map";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

interface IndexEntry { symbol?: string; price?: number; change_pct?: number }
interface MarketOverview {
  brief?: { summary?: string; market_tone?: string; indices?: Record<string, IndexEntry> }
}

const UPSTREAM_TIMEOUT_MS = 8_000;
const MAX_BRIEF_VERDICTS = 5;

async function fetchJSON(path: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}${path}`, { signal: ctrl.signal });
    if (!res.ok) {
      console.error(`[brief] upstream ${path} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[brief] upstream ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally { clearTimeout(t); }
}

// Only the `brief` section is read below. Requesting the default full payload
// (brief,ai_summary,sentiment,history) costs ~16s upstream vs ~0.5s for this
// subset — enough to blow any reasonable request budget for data we discard.
async function fetchMarket(): Promise<MarketOverview | null> {
  return await fetchJSON("/market-overview?sections=brief") as MarketOverview | null;
}

// The backend has no /holdfold endpoint — verdicts are derived from /signals,
// the same way app/api/holdfold does it (shared mapper keeps the two in step).
async function fetchHoldFold(): Promise<HoldFoldVerdict[] | null> {
  const raw = await fetchJSON("/signals");
  if (raw === null) return null;
  const payload = mapSignalsToHoldFold(raw);
  if (!payload) {
    console.error("[brief] /signals returned an unexpected shape");
    return null;
  }
  return payload.verdicts.slice(0, MAX_BRIEF_VERDICTS);
}

export function buildBriefPrompt(
  tier: string,
  market: MarketOverview | null,
  verdicts: HoldFoldVerdict[] | null,
): string {
  const hasMarket = market?.brief != null;
  const hasVerdicts = Array.isArray(verdicts) && verdicts.length > 0;

  // Only state what was actually fetched. Previously the prompt always emitted
  // placeholder lines ("Index data unavailable") *and* still ordered the model
  // to "cite specific indices, percentages, or verdicts" — so on an upstream
  // failure the model dutifully wrote four sentences citing the absence of
  // data. Omit the section instead, and scope the instructions to match.
  const lines: string[] = [`=== REAL MARKET DATA ===`];

  if (hasMarket) {
    const b = market!.brief!;
    if (b.market_tone) lines.push(`Market tone: ${b.market_tone}`);
    if (b.indices) {
      const indices = Object.entries(b.indices).slice(0, 4).map(([name, idx]) => {
        if (idx == null || typeof idx !== "object") return null;
        const chg = idx.change_pct != null ? `${idx.change_pct >= 0 ? "+" : ""}${idx.change_pct.toFixed(2)}%` : "";
        const price = idx.price != null ? idx.price.toLocaleString("en-US") : "n/a";
        return `${name} (${idx.symbol ?? name}): ${price} ${chg}`.trim();
      }).filter((s): s is string => s != null).join(", ");
      if (indices) lines.push(`Indices: ${indices}`);
    }
    if (b.summary) lines.push(`AI summary: ${b.summary}`);
  }

  if (hasVerdicts) {
    const topVerdicts = verdicts!
      .map(v => `${v.ticker}: ${v.verdict} (${v.confidenceLabel})`)
      .join("; ");
    lines.push(`Top Hold/Fold verdicts: ${topVerdicts}`);
  }

  const available = [hasMarket && "index/market data", hasVerdicts && "Hold/Fold verdicts"]
    .filter(Boolean).join(" and ");

  const formatPoints = [
    hasMarket && "Market overview",
    hasVerdicts ? "Standout verdict or signal" : hasMarket && "Standout index move",
    "Key risk to watch",
    "One actionable takeaway",
  ].filter((p): p is string => Boolean(p));

  lines.push(
    `User tier: ${tier}`,
    ``,
    `You are Nu AI, a financial information assistant for NuWrrrld Financial.`,
    `Write a personalized ${formatPoints.length}-sentence morning brief for this ${tier} user.`,
    `Ground every sentence in the EXACT data above — cite only the ${available} shown.`,
    `Never mention missing, unavailable, or unknown data; write only about what is given.`,
    `Format: ${formatPoints.map((p, i) => `${i + 1}) ${p}`).join(" ")}.`,
    `Do not give specific buy/sell price targets. This is informational only, not personalised financial advice.`,
  );

  return lines.join("\n");
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

  // With neither source there is nothing to ground on, and an ungrounded
  // "brief" is worse than none — fail loudly rather than let the model fill
  // four sentences from memory.
  if (market?.brief == null && (verdicts == null || verdicts.length === 0)) {
    return NextResponse.json({ error: "market_data_unavailable" }, { status: 503 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);

  try {
    const prompt = buildBriefPrompt(tier, market, verdicts);
    const { response } = await fetchWithModelFallback(
      apiKey,
      { max_tokens: 350, stream: true, messages: [{ role: "user", content: prompt }], temperature: 0.3 },
      "NuWrrrld Financial Daily Brief",
      ctrl.signal,
    );

    // Content-negotiate: stream SSE to clients that ask for it, return
    // buffered JSON to legacy clients that don't (mirrors /api/nuai —
    // previously missing here despite being specified for all three SSE
    // routes in homebase/interactivity-15.md §3.1).
    const wantsStream = (req.headers.get("Accept") ?? "").includes("text/event-stream");
    const upstream = response.body!;
    const decoder = new TextDecoder();
    const reader = upstream.getReader();

    const drainSSELines = (raw: string, onDelta: (d: string) => void): { remaining: string; done: boolean } => {
      const lines = raw.split("\n");
      const remaining = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return { remaining, done: true };
        try {
          const parsed = JSON.parse(payload);
          const delta: string = parsed?.choices?.[0]?.delta?.content ?? "";
          if (delta) onDelta(delta);
        } catch { /* skip malformed */ }
      }
      return { remaining, done: false };
    };

    if (!wantsStream) {
      let fullText = "";
      let sseBuffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            sseBuffer += decoder.decode();
            if (sseBuffer) drainSSELines(sseBuffer + "\n", d => { fullText += d; });
            break;
          }
          sseBuffer += decoder.decode(value, { stream: true });
          const result = drainSSELines(sseBuffer, d => { fullText += d; });
          sseBuffer = result.remaining;
          if (result.done) break;
        }
      } finally {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
      }
      return NextResponse.json({ answer: fullText });
    }

    const enc = new TextEncoder();
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
