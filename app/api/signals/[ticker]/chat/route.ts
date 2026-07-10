import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 20_000; // agent tool-call loop budget on the backend is ~15s

/**
 * Thin proxy for gcp3's per-signal ask-anything chat agent.
 * POST /api/signals/{ticker}/chat -> { ticker, answer, tool_calls, fallback_used, created_at }
 * The backend agent must call explain_signal before answering — this route
 * just forwards the question and surfaces backend errors as a clean 503.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { ticker } = await params;
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${MCP_URL}/signals/${encodeURIComponent(ticker.toUpperCase())}/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      return NextResponse.json({ error: "signal chat unavailable" }, { status: 503 });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "signal chat unavailable" }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
