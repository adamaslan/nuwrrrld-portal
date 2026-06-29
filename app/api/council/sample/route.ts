export const runtime = 'edge';
/**
 * GET /api/council/sample
 * Returns a cached real AI council pair (T1 short-term + T2 long-term) for SPY.
 * Used by the public landing page — no auth required.
 * Refreshes every 6 hours in-memory; first cold start triggers a live run.
 */
import { NextResponse } from "next/server";
import { callCouncilSeat, type CouncilResponse } from "@/lib/openrouter";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEMO_TICKER = "SPY";

interface CouncilSample {
  shortTerm: CouncilResponse;
  longTerm: CouncilResponse;
  generatedAt: string;
}

let cache: { sample: CouncilSample; expiresAt: number } | null = null;

async function buildPrompt(ticker: string): Promise<string> {
  try {
    const res = await fetch(`${MCP_URL}/signals/${ticker}`, { next: { revalidate: 3600 } });
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      const summary = String(data.ai_summary ?? "");
      const outlook = String(data.ai_outlook ?? "");
      const score = data.ai_score != null ? `AI score: ${data.ai_score}` : "";
      const action = data.ai_action != null ? `Signal: ${data.ai_action}` : "";
      if (summary || outlook) {
        return `Analyze ${ticker}. ${action}. ${score}. ${summary} ${outlook}`.trim();
      }
    }
  } catch { /* fall through to generic prompt */ }
  return `Analyze ${ticker} for current market conditions. Provide a concise, grounded assessment.`;
}

async function generateSample(): Promise<CouncilSample> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const prompt = await buildPrompt(DEMO_TICKER);
  const [shortTerm, longTerm] = await Promise.all([
    callCouncilSeat("T1", prompt, apiKey),
    callCouncilSeat("T2", prompt, apiKey),
  ]);

  return { shortTerm, longTerm, generatedAt: new Date().toISOString() };
}

export async function GET() {
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.sample);
  }

  try {
    const sample = await generateSample();
    cache = { sample, expiresAt: Date.now() + CACHE_TTL_MS };
    return NextResponse.json(sample);
  } catch (err) {
    console.error("Council sample error", err);
    return NextResponse.json({ error: "Council unavailable" }, { status: 503 });
  }
}
