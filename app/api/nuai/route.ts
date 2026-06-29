export const runtime = 'edge';
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
      return NextResponse.json({ error: `AI unavailable: ${response.status}` }, { status: 503 });
    }

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
        recordUsage(userId, tokenCount);
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
