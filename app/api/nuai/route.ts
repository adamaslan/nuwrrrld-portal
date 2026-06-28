import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { isRefusedQuery, NU_AI_DISCLAIMER, NU_AI_DAILY_TOKEN_BUDGET } from "@/lib/nuai";
import type { ChatRequest } from "@/lib/nuai";

// Simple per-user daily token counter (in-memory; resets on cold start).
// For production this should be persisted in a KV store (e.g. Vercel KV).
const dailyUsage = new Map<string, { tokens: number; resetAt: number }>();

function getRemainingBudget(userId: string): number {
  const now = Date.now();
  const rec = dailyUsage.get(userId);
  if (!rec || rec.resetAt < now) {
    dailyUsage.set(userId, { tokens: 0, resetAt: now + 86_400_000 });
    return NU_AI_DAILY_TOKEN_BUDGET;
  }
  return NU_AI_DAILY_TOKEN_BUDGET - rec.tokens;
}

function recordUsage(userId: string, tokens: number) {
  const rec = dailyUsage.get(userId);
  if (rec) rec.tokens += tokens;
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

  if (getRemainingBudget(userId) <= 0) {
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

  const systemPrompt = [
    "You are Nu AI, a financial information assistant for NuWrrrld Financial.",
    "You help users understand their portfolio, market signals, and financial concepts.",
    NU_AI_DISCLAIMER,
    "Never provide specific buy/sell price targets or personalised trading advice.",
    "If you are uncertain, say so clearly rather than guessing.",
    contextLine,
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://financial.nuwrrrld.com",
        "X-Title": "NuWrrrld Financial Nu AI",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-6",
        max_tokens: 1024,
        stream: true,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      clearTimeout(timer);
      const text = await response.text().catch(() => "");
      return NextResponse.json({ error: `AI unavailable: ${response.status}` }, { status: 503 });
    }

    // Pipe the SSE stream from OpenRouter to the client.
    // Each SSE line is: "data: {...}\n\n" or "data: [DONE]\n\n"
    const upstream = response.body!;
    const decoder = new TextDecoder();
    const enc = new TextEncoder();
    let tokenCount = 0;
    let sseBuffer = "";
    const reader = upstream.getReader();

    const stream = new ReadableStream({
      async start(ctrl) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            ctrl.enqueue(enc.encode(chunk));
            // Count only assistant text deltas for budget tracking
            sseBuffer += chunk;
            const lines = sseBuffer.split("\n");
            sseBuffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload);
                const delta: string = parsed?.choices?.[0]?.delta?.content ?? "";
                if (delta) tokenCount += Math.ceil(delta.length / 4);
              } catch { /* skip malformed */ }
            }
          }
        } finally {
          ctrl.close();
          clearTimeout(timer);
          recordUsage(userId, tokenCount);
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
