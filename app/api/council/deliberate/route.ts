/**
 * POST /api/council/deliberate
 * The 10x council (WS2): a multi-seat debate, not a single-shot answer.
 *
 *   1. Ground   — assemble a factual brief (live signal + backtest hit-rates + prior verdicts)
 *   2. Round 1  — DEBATE_SEATS answer the same brief in parallel (per-seat isolated)
 *   3. Round 2  — each seat critiques the others' round-1 answers
 *   4. Synthesis — CHAIR issues consensus/split + a structured verdict
 *   5. Persist   — session, messages, verdict → Neon (non-fatal if unavailable)
 *
 * Free-tier models only, max_tokens capped, daily per-user quota — see WS2.6.
 */
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import {
  DEBATE_SEATS,
  runSeat,
  seatSystemPrompt,
  type CouncilResponse,
  type CouncilSeat,
} from "@/lib/openrouter";
import { buildGroundedBrief } from "@/lib/council-grounding";
import {
  checkAndBumpQuota,
  createSession,
  saveMessage,
  saveVerdict,
  type CouncilVerdict,
} from "@/lib/council-db";

const FREE_DAILY_LIMIT = 5;
const PRO_DAILY_LIMIT = 25;

function parseVerdict(chairText: string): CouncilVerdict {
  const empty: CouncilVerdict = { direction: null, confidence: null, horizon: null, invalidation: null };
  // The chair is asked to end with a single-line JSON verdict; grab the last {...}.
  const match = chairText.match(/\{[^{}]*"direction"[^{}]*\}/g);
  if (!match?.length) return empty;
  try {
    const v = JSON.parse(match[match.length - 1]) as Partial<CouncilVerdict>;
    const dir = v.direction;
    const conf = v.confidence;
    return {
      direction: dir === "bullish" || dir === "bearish" || dir === "neutral" ? dir : null,
      confidence: conf === "low" || conf === "medium" || conf === "high" ? conf : null,
      horizon: typeof v.horizon === "string" ? v.horizon : null,
      invalidation: typeof v.invalidation === "string" ? v.invalidation : null,
    };
  } catch {
    return empty;
  }
}

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
  const { question, ticker = null } = body as { question?: string; ticker?: string | null };
  if (!question?.trim()) {
    return NextResponse.json({ error: "question required" }, { status: 400 });
  }

  const dailyLimit = tier === "free" ? FREE_DAILY_LIMIT : PRO_DAILY_LIMIT;
  const quota = await checkAndBumpQuota(userId, dailyLimit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: "quota_exceeded", used: quota.used, limit: quota.limit },
      { status: 429 },
    );
  }

  const cleanTicker = ticker ? ticker.trim().toUpperCase() : null;
  const brief = await buildGroundedBrief(question.trim(), cleanTicker);
  const sessionId = await createSession(userId, cleanTicker ?? question.trim().slice(0, 80));

  // ── Round 1: independent answers, per-seat isolated ──────────────────────
  const round1 = await Promise.allSettled(
    DEBATE_SEATS.map((seat) =>
      runSeat(seat, [
        { role: "system", content: seatSystemPrompt(seat) },
        { role: "user", content: brief },
      ], apiKey),
    ),
  );

  const answers: Partial<Record<CouncilSeat, CouncilResponse>> = {};
  const emptySeats: CouncilSeat[] = [];
  round1.forEach((r, i) => {
    const seat = DEBATE_SEATS[i];
    if (r.status === "fulfilled" && r.value.answer.trim()) {
      answers[seat] = r.value;
      if (sessionId) void saveMessage(sessionId, { seat, round: 1, role: "answer", model: r.value.model, content: r.value.answer, latencyMs: r.value.latencyMs });
    } else {
      emptySeats.push(seat);
    }
  });

  const answeredSeats = DEBATE_SEATS.filter((s) => answers[s]);
  const peerBlock = answeredSeats
    .map((s) => `[${s}]: ${answers[s]!.answer}`)
    .join("\n\n");

  // ── Round 2: critique — each seat responds to the others ─────────────────
  const round2 = await Promise.allSettled(
    answeredSeats.map((seat) =>
      runSeat(seat, [
        { role: "system", content: seatSystemPrompt(seat) },
        { role: "user", content: brief },
        { role: "assistant", content: answers[seat]!.answer },
        {
          role: "user",
          content:
            `Here are the other seats' answers:\n\n${peerBlock}\n\n` +
            `State specifically where you disagree with them and what evidence would change your mind. ~100 words.`,
        },
      ], apiKey, 350),
    ),
  );

  const critiques: Partial<Record<CouncilSeat, string>> = {};
  round2.forEach((r, i) => {
    const seat = answeredSeats[i];
    if (r.status === "fulfilled" && r.value.answer.trim()) {
      critiques[seat] = r.value.answer;
      if (sessionId) void saveMessage(sessionId, { seat, round: 2, role: "critique", model: r.value.model, content: r.value.answer, latencyMs: r.value.latencyMs });
    }
  });

  // ── Synthesis: the chair reads everything ────────────────────────────────
  const transcript = answeredSeats
    .map((s) => `[${s}] answer: ${answers[s]!.answer}${critiques[s] ? `\n[${s}] critique: ${critiques[s]}` : ""}`)
    .join("\n\n");

  let chairText = "";
  let chairModel = "";
  try {
    const chair = await runSeat("CHAIR", [
      { role: "system", content: seatSystemPrompt("CHAIR") },
      { role: "user", content: `${brief}\n\n=== COUNCIL TRANSCRIPT ===\n${transcript}\n\n${emptySeats.length ? `(Seats unavailable this run: ${emptySeats.join(", ")}.)` : ""}` },
    ], apiKey, 500);
    chairText = chair.answer;
    chairModel = chair.model;
  } catch {
    return NextResponse.json({ error: "Council synthesis unavailable" }, { status: 503 });
  }

  const verdict = parseVerdict(chairText);
  if (sessionId) {
    void saveMessage(sessionId, { seat: "CHAIR", round: 3, role: "synthesis", model: chairModel, content: chairText });
    void saveVerdict(sessionId, cleanTicker, verdict);
  }

  return NextResponse.json({
    sessionId,
    ticker: cleanTicker,
    seats: answeredSeats.map((seat) => ({
      seat,
      answer: answers[seat]!.answer,
      critique: critiques[seat] ?? null,
      model: answers[seat]!.model,
    })),
    degradedSeats: emptySeats,
    synthesis: chairText,
    verdict,
    quota: { used: quota.used, limit: quota.limit },
  });
}
