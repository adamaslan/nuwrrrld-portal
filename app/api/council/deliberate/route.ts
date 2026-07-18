/**
 * POST /api/council/deliberate
 * The 10x council (WS2): a multi-seat debate, not a single-shot answer.
 *
 *   1. Ground   — per-seat brief: live signal + backtest hit-rates + prior
 *                 verdicts + a slice of the compiled grounding pack (PR 3)
 *   2. Round 1  — DEBATE_SEATS answer their own sliced brief in parallel
 *   3. Round 2  — diff-shaped critique: code computes who actually disagrees
 *                 on direction; only those seats get an arbitration prompt
 *                 (docs/council-prompting-small-models.md §8)
 *   4. Synthesis — CHAIR prose call, then a separate verdict-only call run
 *                 3× with majority vote + minimum confidence (§9)
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
  CHAIR_VERDICT_SYSTEM,
  SMALLEST_MODEL,
  type CouncilResponse,
  type CouncilSeat,
} from "@/lib/openrouter";
import { buildGroundedBrief } from "@/lib/council-grounding";
import { computeDisagreements, type VerdictDirection } from "@/lib/council-critique";
import { parseStructuredVerdict } from "@/lib/council-verdict";
import { validateStructuredVerdict, buildRepairMessage } from "@/lib/council-validate";
import {
  checkAndBumpQuota,
  createSession,
  saveMessage,
  saveVerdict,
  type CouncilVerdict,
} from "@/lib/council-db";

const FREE_DAILY_LIMIT = 5;
const PRO_DAILY_LIMIT = 25;
const CHAIR_VERDICT_RUNS = 3;

interface ChairVerdictJson {
  direction?: string;
  confidence?: string;
  horizon?: string;
  invalidation?: string;
}

function parseVerdictJson(text: string): ChairVerdictJson | null {
  // The verdict call is instructed to output ONLY `{...}` — no regex fishing
  // through prose needed now that synthesis and verdict are separate calls.
  try {
    return JSON.parse(text.trim()) as ChairVerdictJson;
  } catch {
    return null;
  }
}

const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

/** Majority-vote direction and take the minimum confidence across N verdict
 * samples — if the transcript can flip direction between samples, confidence
 * was never "high" (docs/council-prompting-small-models.md §9). */
function reconcileVerdicts(samples: ChairVerdictJson[]): CouncilVerdict {
  const empty: CouncilVerdict = { direction: null, confidence: null, horizon: null, invalidation: null };
  if (!samples.length) return empty;

  const counts: Record<VerdictDirection, number> = { bullish: 0, bearish: 0, neutral: 0 };
  for (const s of samples) {
    if (s.direction === "bullish" || s.direction === "bearish" || s.direction === "neutral") {
      counts[s.direction] += 1;
    }
  }
  const ranked = (Object.entries(counts) as Array<[VerdictDirection, number]>).sort((a, b) => b[1] - a[1]);
  const direction = ranked[0][1] > 0 ? ranked[0][0] : null;

  let confidence: "low" | "medium" | "high" | null = null;
  for (const s of samples) {
    if (s.confidence === "low" || s.confidence === "medium" || s.confidence === "high") {
      if (confidence === null || CONFIDENCE_RANK[s.confidence] < CONFIDENCE_RANK[confidence]) {
        confidence = s.confidence;
      }
    }
  }

  // Horizon/invalidation: take the first sample's values — they're
  // descriptive text, not something to vote on the way direction is.
  const first = samples.find((s) => s.direction) ?? samples[0];
  return {
    direction,
    confidence,
    horizon: typeof first.horizon === "string" ? first.horizon : null,
    invalidation: typeof first.invalidation === "string" ? first.invalidation : null,
  };
}

function extractEvidenceId(text: string): string | null {
  const match = text.match(/\[C\d+\]/);
  return match ? match[0] : null;
}

/**
 * The repair loop (docs/council-prompting-small-models.md §7), applied to
 * T1/T2 only — they're the only round-1 seats with a numeric EXECUTION field
 * to validate. One mechanical retry, then accept-with-flags: the flagged
 * answer is still used if the repair doesn't parse, since a `[UNVERIFIED]`
 * answer beats no answer for that seat.
 */
async function answerWithRepair(
  seat: CouncilSeat,
  brief: string,
  apiKey: string,
): Promise<CouncilResponse> {
  const first = await runSeat(seat, [
    { role: "system", content: seatSystemPrompt(seat) },
    { role: "user", content: brief },
  ], apiKey);

  if (seat !== "T1" && seat !== "T2") return first;

  const verdict = parseStructuredVerdict(first.answer);
  if (!verdict) return first;

  const flags = validateStructuredVerdict(verdict, brief);
  if (!flags.length) return first;

  try {
    const repaired = await runSeat(seat, [
      { role: "system", content: seatSystemPrompt(seat) },
      { role: "user", content: brief },
      { role: "assistant", content: first.answer },
      { role: "user", content: buildRepairMessage(flags) },
    ], apiKey, 500);
    return parseStructuredVerdict(repaired.answer) ? repaired : first;
  } catch {
    return first;
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
  const sessionId = await createSession(userId, cleanTicker ?? question.trim().slice(0, 80));

  // ── Ground + Round 1: each seat gets its own sliced brief ────────────────
  const briefBySeat = new Map<CouncilSeat, string>();
  const round1 = await Promise.allSettled(
    DEBATE_SEATS.map(async (seat) => {
      const brief = await buildGroundedBrief(question.trim(), cleanTicker, seat);
      briefBySeat.set(seat, brief);
      return answerWithRepair(seat, brief, apiKey);
    }),
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

  // ── Round 2: diff-shaped critique — code decides who actually disagrees ──
  const { majority, directions, disagreeing } = computeDisagreements(
    answeredSeats.map((seat) => ({ seat, answer: answers[seat]!.answer })),
  );

  const critiques: Partial<Record<CouncilSeat, string>> = {};
  if (majority && disagreeing.length) {
    const majoritySeat = answeredSeats.find((s) => directions[s] === majority);
    const majorityAnswer = majoritySeat ? answers[majoritySeat]!.answer : "";
    const evidenceId = extractEvidenceId(majorityAnswer);

    const round2 = await Promise.allSettled(
      disagreeing.map((seat) => {
        const ownDirection = directions[seat] ?? "its own direction";
        const prompt =
          `You said: ${ownDirection}. ${majoritySeat ?? "The majority"} said: ${majority}` +
          `${evidenceId ? `, citing ${evidenceId}` : ""}.\n\n` +
          `Answer in 3 lines:\n` +
          `DECIDER: the single data point that settles this disagreement\n` +
          `IF_RIGHT: what happens to ${evidenceId ?? "their argument"} if your ${ownDirection} call is right\n` +
          `CHANGE_MY_MIND: the one number that would flip you to ${majority}`;
        return runSeat(seat, [
          { role: "system", content: seatSystemPrompt(seat) },
          { role: "user", content: briefBySeat.get(seat) ?? "" },
          { role: "assistant", content: answers[seat]!.answer },
          { role: "user", content: prompt },
        ], apiKey, 200);
      }),
    );
    round2.forEach((r, i) => {
      const seat = disagreeing[i];
      if (r.status === "fulfilled" && r.value.answer.trim()) {
        critiques[seat] = r.value.answer;
        if (sessionId) void saveMessage(sessionId, { seat, round: 2, role: "critique", model: r.value.model, content: r.value.answer, latencyMs: r.value.latencyMs });
      }
    });
  }

  // ── Synthesis: the chair reads everything, then a separate verdict call ──
  const transcript = answeredSeats
    .map((s) => `[${s}] answer: ${answers[s]!.answer}${critiques[s] ? `\n[${s}] critique (disagrees with ${majority}): ${critiques[s]}` : "\n(agrees with the majority — no round 2)"}`)
    .join("\n\n");
  const chairBrief = await buildGroundedBrief(question.trim(), cleanTicker, "CHAIR");

  let chairText = "";
  let chairModel = "";
  try {
    const chair = await runSeat("CHAIR", [
      { role: "system", content: seatSystemPrompt("CHAIR") },
      { role: "user", content: `${chairBrief}\n\n=== COUNCIL TRANSCRIPT ===\n${transcript}\n\n${emptySeats.length ? `(Seats unavailable this run: ${emptySeats.join(", ")}.)` : ""}` },
    ], apiKey, 400);
    chairText = chair.answer;
    chairModel = chair.model;
  } catch {
    return NextResponse.json({ error: "Council synthesis unavailable" }, { status: 503 });
  }

  // Seat-to-model assignment (docs/council-prompting-small-models.md §10):
  // the verdict is an 80-token JSON classification task, not the hard job —
  // run it on the smallest model in the chain, 3x, instead of CHAIR's
  // primary (best free) model that synthesis just used.
  const verdictSamples = await Promise.allSettled(
    Array.from({ length: CHAIR_VERDICT_RUNS }, () =>
      runSeat("CHAIR", [
        { role: "system", content: CHAIR_VERDICT_SYSTEM },
        { role: "user", content: `${chairText}\n\n=== COUNCIL TRANSCRIPT ===\n${transcript}` },
      ], apiKey, 100, 0.7, SMALLEST_MODEL),
    ),
  );
  const parsedSamples = verdictSamples
    .filter((r): r is PromiseFulfilledResult<CouncilResponse> => r.status === "fulfilled")
    .map((r) => parseVerdictJson(r.value.answer))
    .filter((v): v is ChairVerdictJson => v !== null);

  const verdict = reconcileVerdicts(parsedSamples);
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
