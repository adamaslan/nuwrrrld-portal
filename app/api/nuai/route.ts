import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { isRefusedQuery, NU_AI_DISCLAIMER, NU_AI_DAILY_TOKEN_BUDGET } from "@/lib/nuai";
import type { ChatRequest } from "@/lib/nuai";
import { fetchWithModelFallback } from "@/lib/openrouter";
import { getUsedTokensToday, addTokenUsage } from "@/lib/nuai-db";
import { getWatchlist } from "@/lib/watchlist-store";
import { getOrFetchDigest } from "@/lib/digest-cache";
import { fetchTickerSignalBrief } from "@/lib/shared/signal-lookup";

// Matches a bare uppercase ticker-like token (2-5 letters) in free text.
const TICKER_TOKEN_RE = /\b[A-Z]{2,5}\b/g;

// Durable daily token budget: Neon is the source of truth (survives cold
// starts); this Map is an in-process L1 in front of it, refreshed every 60s
// per user so a burst of requests within a minute doesn't hammer the DB.
const L1_TTL_MS = 60_000;
const dailyUsageL1 = new Map<string, { tokens: number; expiresAt: number }>();

async function getRemainingBudget(userId: string): Promise<number> {
  const now = Date.now();
  const cached = dailyUsageL1.get(userId);
  if (cached && cached.expiresAt > now) {
    return NU_AI_DAILY_TOKEN_BUDGET - cached.tokens;
  }
  const used = await getUsedTokensToday(userId);
  dailyUsageL1.set(userId, { tokens: used, expiresAt: now + L1_TTL_MS });
  return NU_AI_DAILY_TOKEN_BUDGET - used;
}

async function recordUsage(userId: string, tokens: number) {
  const cached = dailyUsageL1.get(userId);
  if (cached) cached.tokens += tokens;
  await addTokenUsage(userId, tokens);
}

// Per-minute rate limit — in-memory fixed-window counter, deliberately simple
// (no external dependency) since it only needs to survive within one
// serverless instance's lifetime to blunt a request burst; the daily budget
// above is the durable backstop.
const RATE_LIMIT_MAX_PER_MINUTE = 12;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitWindows = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const rec = rateLimitWindows.get(userId);
  if (!rec || now - rec.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (rec.count >= RATE_LIMIT_MAX_PER_MINUTE) return false;
  rec.count += 1;
  return true;
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    return NextResponse.json({ error: "upgrade_required", upgradeUrl: "/pricing?source=nuai" }, { status: 403 });
  }

  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: "rate_limit_exceeded" }, { status: 429 });
  }

  if ((await getRemainingBudget(userId)) <= 0) {
    return NextResponse.json({ error: "daily_limit_reached" }, { status: 429 });
  }

  const body: ChatRequest = await req.json().catch(() => ({ messages: [] }));
  const { messages = [], portfolioContext = [] } = body;

  if (!messages.length) {
    return NextResponse.json({ error: "messages required" }, { status: 400 });
  }

  const lastUserMessage = messages.at(-1);
  if (lastUserMessage?.role === "user" && isRefusedQuery(lastUserMessage.content)) {
    return NextResponse.json({
      message: {
        role: "assistant",
        content: "I can't help with that. " + NU_AI_DISCLAIMER,
        timestamp: new Date().toISOString(),
      },
      flagged: true,
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 503 });

  const contextLine = portfolioContext.length > 0
    ? `The user currently holds: ${portfolioContext.join(", ")}.`
    : "The user has not connected a portfolio yet.";

  // Give Nu AI access to the app's own data — the user's watchlist and the
  // latest signals digest — so it can answer questions grounded in what the
  // app is actually showing, not just generic knowledge. Both are best-effort:
  // a watchlist/digest outage degrades to "unavailable" rather than failing
  // the whole chat request.
  const [watchlist, digest] = await Promise.all([
    getWatchlist(userId).catch(() => []),
    getOrFetchDigest(userId).catch(() => null),
  ]);

  const watchlistLine = watchlist.length > 0
    ? `The user's watchlist: ${watchlist.map(w => w.ticker).join(", ")}.`
    : "The user has not added any tickers to their watchlist yet.";

  const digestLine = digest && Array.isArray(digest.signals) && digest.signals.length > 0
    ? `Latest signals digest (generated ${digest.generatedAt}): ` +
      digest.signals
        .slice(0, 8)
        .map(s => `${s.ticker} ${s.direction} (${s.confidence} confidence)`)
        .join("; ") + "."
    : "No live signals digest is currently available.";

  // If the user's question names a ticker we actually track (watchlist or
  // digest), fetch that ticker's REAL DATA brief — same grounding pattern as
  // "Go deeper" (lib/shared/prompts.ts) — so Nu AI can cite live signal
  // detail instead of falling back to generic knowledge for tracked tickers.
  const trackedTickers = new Set([
    ...watchlist.map(w => w.ticker),
    ...(digest?.signals ?? []).map(s => s.ticker),
  ]);
  const mentionedTicker = lastUserMessage?.role === "user"
    ? (lastUserMessage.content.match(TICKER_TOKEN_RE) ?? []).find(t => trackedTickers.has(t))
    : undefined;
  const tickerBrief = mentionedTicker
    ? await fetchTickerSignalBrief(mentionedTicker).catch(() => null)
    : null;
  const tickerLine = tickerBrief ? `=== REAL DATA: ${mentionedTicker} ===\n${tickerBrief}` : null;

  const systemPrompt = [
    "You are Nu AI, a financial information assistant for NuWrrrld Financial.",
    "You help users understand their portfolio, market signals, and financial concepts.",
    NU_AI_DISCLAIMER,
    "Never provide specific buy/sell price targets or personalised trading advice.",
    "If you are uncertain, say so clearly rather than guessing.",
    "This app tracks sector/industry ETFs and the user's own watchlist, not individual stocks in general — " +
      "if asked about a ticker outside that scope, say so plainly rather than apologizing as if something is broken.",
    contextLine,
    watchlistLine,
    digestLine,
    ...(tickerLine ? [tickerLine] : []),
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const { response } = await fetchWithModelFallback(
      apiKey,
      {
        max_tokens: 1024,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.map(m => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          })),
        ],
      },
      "NuWrrrld Financial Nu AI",
      controller.signal,
    );

    // Content-negotiate: stream SSE to clients that ask for it,
    // return buffered JSON to legacy clients (shipped mobile builds) that don't.
    const wantsStream = (req.headers.get("Accept") ?? "").includes("text/event-stream");

    const upstream = response.body!;
    const decoder = new TextDecoder();
    // Seed with a prompt cost estimate so large prompts count toward budget
    const estimateTokens = (text: string) => Math.ceil(text.length / 4);
    let tokenCount = estimateTokens(systemPrompt)
      + messages.reduce((total, m) => total + estimateTokens(m.content), 0);
    let sseBuffer = "";
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
      // Legacy path: collect all delta text and return a ChatResponse JSON object.
      let fullText = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            sseBuffer += decoder.decode();
            if (sseBuffer) drainSSELines(sseBuffer + "\n", d => { fullText += d; tokenCount += estimateTokens(d); });
            break;
          }
          sseBuffer += decoder.decode(value, { stream: true });
          const result = drainSSELines(sseBuffer, d => { fullText += d; tokenCount += estimateTokens(d); });
          sseBuffer = result.remaining;
          if (result.done) break;
        }
      } finally {
        clearTimeout(timer);
        void recordUsage(userId, tokenCount);
        reader.cancel().catch(() => {});
      }
      return NextResponse.json({
        message: {
          role: "assistant",
          content: fullText,
          timestamp: new Date().toISOString(),
        },
        flagged: false,
      });
    }

    // SSE streaming path: pipe OpenRouter stream directly to the client.
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            ctrl.enqueue(enc.encode(chunk));
            // Count assistant text deltas for budget tracking
            sseBuffer += chunk;
            const result = drainSSELines(sseBuffer, d => { tokenCount += estimateTokens(d); });
            sseBuffer = result.remaining;
            if (result.done) break;
          }
          ctrl.close();
        } catch (err) {
          ctrl.error(err);
        } finally {
          clearTimeout(timer);
          void recordUsage(userId, tokenCount);
        }
      },
      cancel() {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
        controller.abort();
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
    console.error("Nu AI error", err);
    return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
  }
}
