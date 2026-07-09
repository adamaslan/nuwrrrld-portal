import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { fetchBacktest } from "@/lib/backtest";

/**
 * Thin proxy for the (separate) signals-app backtest engine.
 * GET /api/backtest/{symbol} -> { symbol, period, horizon_days, bars_scanned, by_category, by_strength }
 * Returns 204 (no body) when the engine is disabled/unreachable — this is a
 * nice-to-have enhancement, callers must treat "no data" as normal, not an error.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { symbol } = await params;
  const result = await fetchBacktest(symbol.toUpperCase());
  if (!result) return new NextResponse(null, { status: 204 });

  return NextResponse.json(result);
}
