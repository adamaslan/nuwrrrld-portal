/**
 * POST /api/scans/assist
 * X26-04: explain why a scan card has no result, in plain words. Off by default (flag `scan_ai_assist`).
 *
 * Input is a catalog card id only. The state and the prompt are built on the server from catalog facts; the
 * caller cannot add text. The model is reached only through callCouncilSeat, which walks FREE_MODEL_CHAIN, so
 * the specific model can rotate in lib/openrouter.ts without touching this route. The answer is shown only if it
 * passes validateAssistAnswer. Otherwise the deterministic text is returned.
 *
 * Quota: shares the daily per-IP pool with /api/council/public. That coupling is deliberate for now and is
 * called out in the PR.
 */
import { NextRequest, NextResponse } from "next/server";
import { callCouncilSeat } from "@/lib/openrouter";
import { checkAndIncrementDemoQuota, clientIpFromHeaders, hashIp, releaseDemoQuota } from "@/lib/public-demo";
import { flagLive } from "@/lib/flags";
import { SEED_CARDS, findCard } from "@/lib/shared/se1-catalog";
import {
  assistFactsFor, buildAssistPrompt, deterministicExplanation, validateAssistAnswer,
} from "@/lib/shared/se1/assist-explainer";

export async function POST(req: NextRequest) {
  if (!flagLive("scan_ai_assist")) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  const ipHashSecret = process.env.IP_HASH_SECRET;
  if (!apiKey || !ipHashSecret) {
    return NextResponse.json({ error: "Assist not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { card?: unknown };
  const card = typeof body.card === "string" ? findCard(SEED_CARDS, body.card) : undefined;
  if (!card) {
    return NextResponse.json({ error: "unknown scan card" }, { status: 400 });
  }

  const facts = assistFactsFor(card);
  const fallback = deterministicExplanation(facts);
  const ipHash = hashIp(clientIpFromHeaders(req.headers), ipHashSecret);

  if (!(await checkAndIncrementDemoQuota(ipHash))) {
    return NextResponse.json({ card: card.id, state: facts.state, answer: fallback, source: "deterministic", reason: "quota" });
  }

  try {
    // 1200 is the smallest budget the chain reliably fills (see lib/openrouter.ts); answerOnly turns off reasoning
    // on the optional-reasoning models so chain-of-thought does not reach the answer.
    const result = await callCouncilSeat("QUANT", buildAssistPrompt(facts), apiKey, 1200, { answerOnly: true });
    const check = validateAssistAnswer(result.answer, facts);
    if (check.ok) {
      return NextResponse.json({ card: card.id, state: facts.state, answer: result.answer.trim(), source: "model", model: result.model });
    }
    // The call happened, so its quota slot stays used.
    return NextResponse.json({ card: card.id, state: facts.state, answer: fallback, source: "deterministic", reason: check.reason });
  } catch (err) {
    console.error("[scans/assist] model call failed", err);
    await releaseDemoQuota(ipHash);
    return NextResponse.json(
      { card: card.id, state: facts.state, answer: fallback, source: "deterministic", reason: "model_unavailable" },
      { status: 503 },
    );
  }
}
