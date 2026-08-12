/**
 * POST /api/analyze — per-ticker Hold/Fold analysis, proxied to
 * holdemfoldemapp's backend (MCP_ANALYZE_URL). Deliberately a separate
 * upstream from MCP_BACKEND_URL's batch /signals feed used by
 * app/api/holdfold/route.ts — see lib/env.ts for why.
 *
 * Kept thin per this repo's convention (authenticate → delegate → translate):
 * the analysis itself happens on the backend, this route only gates, caches,
 * and forwards errors in a form an operator can act on.
 */
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { analyzeCacheKey, isGenericAnalyzeRequest } from "@/lib/shared/analyze-policy";
import { getCachedAnalysis, saveAnalysis } from "@/lib/analyze-cache-db";

const BACKEND = process.env.MCP_ANALYZE_URL;
const TIMEOUT_MS = 8_000;

const requestSchema = z.object({
  symbol: z.string().min(1).max(10),
  period: z.string().default("3mo"),
  asset_type: z.string().default("stock"),
  risk_profile: z.string().default("moderate"),
  options_strategy: z.string().nullable().optional(),
  options_legs: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
  position_qty: z.number().nullable().optional(),
  position_entry: z.number().nullable().optional(),
  position_side: z.string().default("long"),
  position_lots: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  if (!BACKEND) {
    return NextResponse.json(
      { error: "Analysis backend not configured — MCP_ANALYZE_URL is unset" },
      { status: 503 },
    );
  }

  const rawBody = await req.json().catch(() => null);
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request", detail: parsed.error.issues }, { status: 400 });
  }

  const symbol = normalizeTicker(parsed.data.symbol);
  if (!symbol) {
    return NextResponse.json({ error: `invalid ticker: ${parsed.data.symbol}` }, { status: 400 });
  }

  const body = { ...parsed.data, symbol };
  // The cache key is position/options-agnostic, so only a generic request may
  // read or write it — a personalized response cached under this key would be
  // served to the next caller asking about the same ticker with no position.
  const cacheable = isGenericAnalyzeRequest(body);
  const key = analyzeCacheKey({
    symbol,
    period: body.period,
    assetType: body.asset_type,
    riskProfile: body.risk_profile,
  });

  if (cacheable) {
    const cached = await getCachedAnalysis(key);
    if (cached) return NextResponse.json(cached);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BACKEND}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = String(err).includes("ECONNREFUSED") || String(err).includes("abort")
      ? `Analysis backend unreachable at ${BACKEND} — is holdemfoldem-api up?`
      : `Failed to reach analysis backend: ${err}`;
    return NextResponse.json({ error: msg }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const detail = data?.detail ?? data?.error ?? data?.message ?? `Backend error ${res.status}: ${res.statusText}`;
    return NextResponse.json({ error: detail }, { status: res.status });
  }

  if (cacheable) await saveAnalysis(key, symbol, data);
  return NextResponse.json(data);
}
