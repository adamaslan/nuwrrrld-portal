import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { localSignalChat, type SignalChatAnswer } from "@/lib/signal-chat-local";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 20_000; // agent tool-call loop budget on the backend is ~15s

type ChatSource = "upstream" | "local";

/**
 * Per-signal ask-anything chat.
 * POST /api/signals/{ticker}/chat -> { ticker, answer, tool_calls, fallback_used, created_at }
 *
 * This was a pure proxy to gcp3's `/signals/{ticker}/chat`. That endpoint is not
 * registered on gcp3 — confirmed against the backend's live OpenAPI — so the
 * proxy 404'd upstream and this route returned 503 to every user on every call,
 * for as long as the feature has existed. See lib/signal-chat-local.ts for the
 * full finding and docs/wiki-portal/incident-2026-09-11-nulogdash-blind-sweep.md.
 *
 * Upstream is still tried first and still wins when it answers the contract, so
 * a future gcp3 deploy takes over with no change here. Every other outcome —
 * unreachable, non-2xx, or a 200 that isn't this shape — grounds locally on
 * `/signals/{ticker}` instead of degrading to an error. `X-Signal-Chat-Source`
 * says which path answered; an unlabelled substitute would be the same silent
 * swap that made the portfolio-health outage invisible for 47 days.
 */
function respond(payload: SignalChatAnswer, source: ChatSource) {
  return NextResponse.json(payload, { headers: { "X-Signal-Chat-Source": source } });
}

/**
 * Ask gcp3. Returns null on every failure mode, including a 200 carrying
 * something that is not this contract — a missing `answer` is a miss, not an
 * empty answer to forward.
 */
async function fetchUpstreamChat(ticker: string, question: string): Promise<SignalChatAnswer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals/${encodeURIComponent(ticker)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== "object") return null;
    const data = raw as Partial<SignalChatAnswer>;
    if (typeof data.answer !== "string" || data.answer.trim() === "") return null;
    return {
      ticker,
      answer: data.answer,
      tool_calls: Array.isArray(data.tool_calls) ? data.tool_calls : [],
      fallback_used: !!data.fallback_used,
      created_at: data.created_at ?? new Date().toISOString(),
      model: data.model,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { ticker: rawTicker } = await params;
  if (!rawTicker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
  const ticker = rawTicker.toUpperCase();

  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const upstream = await fetchUpstreamChat(ticker, question);
  if (upstream) return respond(upstream, "upstream");

  try {
    return respond(await localSignalChat(ticker, question), "local");
  } catch (err) {
    // Terminal honest state: no upstream agent and nothing to ground a local
    // answer in. Never a speculated answer — see concept-graceful-degradation.
    console.error(`[signals/chat] local path failed for ${ticker}:`, err);
    return NextResponse.json(
      { error: "signal chat unavailable" },
      { status: 503, headers: { "X-Signal-Chat-Source": "local" } },
    );
  }
}
