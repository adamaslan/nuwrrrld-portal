import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { callCouncilSeat, type CouncilSeat } from "@/lib/openrouter";
import { parseStructuredVerdict, directionFromOutlook } from "@/lib/council-verdict";
import { createSession, saveMessage, saveVerdict } from "@/lib/council-db";

/**
 * POST /api/council — single-seat quick-ask (T1/T2), used by the Hold/Fold
 * ticker detail panel.
 *
 * Audit 2026-07-15 fix: the seat prompt (lib/openrouter.ts) now requires a
 * strict labeled-field format instead of free prose, so the model's raw
 * chain-of-thought can no longer leak into the rendered answer. This route
 * parses and validates that structure before responding — if the model
 * still doesn't comply, it retries once with a stricter instruction, then
 * falls back to an explicit error the frontend renders as a fallback state
 * instead of raw/truncated text. Valid verdicts are persisted to the
 * council_verdicts ledger (same table the /api/council/deliberate flow
 * writes to) so the T1/T2 quick-ask also contributes to the verdict record.
 */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    return NextResponse.json({ error: "upgrade_required" }, { status: 403 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Council not configured" }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const { prompt, seat = "T1", ticker = null } = (body || {}) as {
    prompt?: string;
    seat?: CouncilSeat;
    ticker?: string | null;
  };

  if (!prompt?.trim()) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }

  try {
    let result = await callCouncilSeat(seat as CouncilSeat, prompt, apiKey);
    let verdict = parseStructuredVerdict(result.answer);

    if (!verdict) {
      // One retry with a stricter, explicit corrective instruction — cheap
      // insurance against a model that ignored the format on the first try.
      const retryPrompt =
        `${prompt}\n\n` +
        `Your previous response did not follow the required format. ` +
        `Respond again using ONLY the six required labeled fields (OUTLOOK, KEY_DRIVER, ` +
        `INVALIDATION_LEVEL, ENTRY, EXIT, STOP) — no other text.`;
      result = await callCouncilSeat(seat as CouncilSeat, retryPrompt, apiKey);
      verdict = parseStructuredVerdict(result.answer);
    }

    if (!verdict) {
      console.error(`Council ${seat} returned an unparsable response after retry`, {
        preview: result.answer.slice(0, 200),
      });
      return NextResponse.json(
        { error: "council_response_invalid" },
        { status: 502 },
      );
    }

    const cleanTicker = ticker ? ticker.trim().toUpperCase() : null;
    const sessionId = await createSession(userId, cleanTicker ?? prompt.trim().slice(0, 80));
    if (sessionId) {
      void saveMessage(sessionId, {
        seat: seat as CouncilSeat,
        round: 1,
        role: "answer",
        model: result.model,
        content: result.answer,
        latencyMs: result.latencyMs,
      });
      void saveVerdict(sessionId, cleanTicker, {
        direction: directionFromOutlook(verdict.outlook),
        confidence: null,
        horizon: seat === "T1" ? "1-5d" : "3-12m",
        invalidation: verdict.invalidationLevel,
      });
    }

    return NextResponse.json({ verdict, model: result.model, seat });
  } catch (err) {
    console.error("Council error", err);
    return NextResponse.json({ error: "Council unavailable" }, { status: 503 });
  }
}
