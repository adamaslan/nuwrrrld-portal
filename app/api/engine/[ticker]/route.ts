/**
 * GET /api/engine/[ticker] — the engine's fib ladder as a FibSummary.
 * 404 unless ENGINE_LADDER_ENABLED=true: shipped dark until the shadow
 * comparison against signals-app passes (CLOUD-ENGINE.md, step 5).
 */
import { NextRequest, NextResponse } from "next/server";
import { latestStructure } from "@/lib/engine-db";
import { engineLadderEnabled, structureToFibSummary } from "@/lib/shared/engine-ladder";
import { normalizeTicker } from "@/lib/shared/signal-policy";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  if (!engineLadderEnabled()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ticker = normalizeTicker((await ctx.params).ticker);
  if (!ticker) return NextResponse.json({ error: "invalid ticker" }, { status: 400 });
  try {
    const row = await latestStructure(ticker);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({
      ticker,
      barDate: row.bar_date,
      codeVersion: row.code_version,
      ...structureToFibSummary(row as never),
    });
  } catch (err) {
    console.error(`[engine-ladder] ${ticker} failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "lookup failed" }, { status: 500 });
  }
}
