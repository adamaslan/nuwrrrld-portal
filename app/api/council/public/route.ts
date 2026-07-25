/**
 * POST /api/council/public
 * Unauthenticated "ask the council" demo for the landing page. Ticker-only
 * input — never a free-text prompt from an anonymous caller — because the
 * prompt template is built entirely server-side, closing the prompt-injection
 * door a public endpoint would otherwise open.
 *
 * Cost model: cache hit (someone already asked about this ticker today) is
 * free and unlimited; a cache miss costs the caller one of their 1-per-day
 * quota slots and triggers a single RISK-seat call on the existing $0
 * free-tier model chain (lib/openrouter.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { hashIp, clientIpFromHeaders, checkAndIncrementDemoQuota, releaseDemoQuota, getCachedDemoAnswer, saveDemoAnswer } from "@/lib/public-demo";
import { callCouncilSeat } from "@/lib/openrouter";
import { fetchTickerEntry, formatTickerBrief } from "@/lib/shared/signal-lookup";

const DEMO_SEAT = "RISK" as const;

function buildDemoPrompt(ticker: string, brief: string | null): string {
  const grounding = brief ? `\n\n=== LIVE SIGNAL DATA (${ticker}) ===\n${brief}` : "";
  return (
    `A visitor with no account is trying the council demo on ${ticker}. ` +
    `Give your honest RISK-seat take: what could go wrong with this trade, and what would prove it wrong. ` +
    `Keep it to 2-3 sentences — this is a free preview, not the full deliberation.` +
    grounding
  );
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Demo not configured" }, { status: 503 });
  }

  const body = await req.json().catch(() => ({}));
  const ticker = normalizeTicker((body as Record<string, unknown>)?.ticker);
  if (!ticker) {
    return NextResponse.json({ error: "valid ticker required" }, { status: 400 });
  }

  // Cache hit — free, unlimited, no quota consumed.
  const cached = await getCachedDemoAnswer(ticker, DEMO_SEAT);
  if (cached) {
    return NextResponse.json({ ticker, answer: cached.answer, model: cached.model, cached: true });
  }

  // Cache miss — consume one of this caller's daily quota slots. Fails
  // closed: a DB outage here means the demo is unavailable, not free-for-all.
  const ipHash = hashIp(clientIpFromHeaders(req.headers));
  const allowed = await checkAndIncrementDemoQuota(ipHash);
  if (!allowed) {
    return NextResponse.json(
      { error: "daily_limit_reached", message: "You've used today's free question — sign up for unlimited access." },
      { status: 429 },
    );
  }

  const entry = await fetchTickerEntry(ticker);
  const brief = entry ? formatTickerBrief(entry) : null;

  try {
    const result = await callCouncilSeat(DEMO_SEAT, buildDemoPrompt(ticker, brief), apiKey, 220);
    await saveDemoAnswer(ticker, DEMO_SEAT, result.answer, result.model);
    return NextResponse.json({ ticker, answer: result.answer, model: result.model, cached: false });
  } catch (err) {
    console.error("[council/public] demo call failed", err);
    await releaseDemoQuota(ipHash);
    return NextResponse.json({ error: "Council demo temporarily unavailable" }, { status: 503 });
  }
}
