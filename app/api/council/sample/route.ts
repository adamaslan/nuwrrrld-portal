/**
 * GET /api/council/sample
 * Returns a cached real AI council pair (T1 short-term + T2 long-term) run
 * against a $10,000 MOO (VanEck Agribusiness ETF) simulation. Used by the
 * public landing page — no auth required.
 * Refreshes every 6 hours in-memory; first cold start triggers a live run.
 *
 * 2026-09-02: switched from a bare SPY signal prompt to an explicit ETF
 * investment-simulation framing (see docs/moo-council-simulation-todo.md).
 * SIMULATED_CAPITAL_USD is a fixed, hardcoded figure — never user input —
 * so this unauthenticated route's prompt stays entirely server-built, the
 * same constraint /api/council/public documents for its ticker-only input.
 */
import { NextResponse } from "next/server";
import { callCouncilSeat, type CouncilResponse } from "@/lib/openrouter";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEMO_TICKER = "MOO";
const DEMO_FUND_NAME = "VanEck Agribusiness ETF";
const SIMULATED_CAPITAL_USD = 10_000;

interface CouncilSample {
  ticker: string;
  fundName: string;
  simulatedCapitalUsd: number;
  shortTerm: CouncilResponse;
  longTerm: CouncilResponse;
  generatedAt: string;
}

let cache: { sample: CouncilSample; expiresAt: number } | null = null;

function buildSimulationPrompt(ticker: string, fundName: string, signal: Record<string, unknown> | null): string {
  const header =
    `Simulation: a retail investor is considering putting $${SIMULATED_CAPITAL_USD.toLocaleString()} into ` +
    `${ticker} (${fundName}) today. Give your seat's take on this specific investment.`;

  if (!signal) {
    return `${header} No live signal data was available for this run — answer from general market ` +
      `conditions only, and say plainly that live data was unavailable rather than inventing figures.`;
  }

  const summary = String(signal.ai_summary ?? "");
  const outlook = String(signal.ai_outlook ?? "");
  const score = signal.ai_score != null ? `AI confluence score: ${signal.ai_score}/100.` : "";
  const action = signal.ai_action != null ? `Current signal: ${signal.ai_action}.` : "";
  const grounding = [action, score, summary, outlook].filter(Boolean).join(" ");

  return `${header}\n\n=== LIVE SIGNAL DATA (${ticker}) ===\n${grounding || "(no fields populated)"}`.trim();
}

async function fetchLiveSignal(ticker: string): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${MCP_URL}/signals/${ticker}`, { next: { revalidate: 3600 }, signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`MCP signal fetch timed out for ${ticker}`);
    }
    return null;
  }
}

async function generateSample(): Promise<CouncilSample> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const signal = await fetchLiveSignal(DEMO_TICKER);
  const prompt = buildSimulationPrompt(DEMO_TICKER, DEMO_FUND_NAME, signal);
  const [shortTerm, longTerm] = await Promise.all([
    callCouncilSeat("T1", prompt, apiKey),
    callCouncilSeat("T2", prompt, apiKey),
  ]);

  return {
    ticker: DEMO_TICKER,
    fundName: DEMO_FUND_NAME,
    simulatedCapitalUsd: SIMULATED_CAPITAL_USD,
    shortTerm,
    longTerm,
    generatedAt: new Date().toISOString(),
  };
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
