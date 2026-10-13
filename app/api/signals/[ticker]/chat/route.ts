import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { localSignalChat, type SignalChatAnswer } from "@/lib/signal-chat-local";

const MAX_QUESTION_LENGTH = 500;

/** Answer signal questions locally because gcp3 does not expose a chat endpoint. */
function respond(payload: SignalChatAnswer) {
  return NextResponse.json(payload, { headers: { "X-Signal-Chat-Source": "local" } });
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
  if (question.length > MAX_QUESTION_LENGTH) {
    return NextResponse.json({ error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer` }, { status: 400 });
  }

  try {
    return respond(await localSignalChat(ticker, question));
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
