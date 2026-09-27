/**
 * POST /api/pipeline/daily-bars — store daily OHLCV instead of discarding it.
 * GET returns the latest stored bar date per feed so the fetcher can be incremental.
 * Auth: Bearer PORTAL_PUSH_SECRET. Never calls a model.
 */
import { NextRequest, NextResponse } from "next/server";
import { latestBarDates, upsertBars } from "@/lib/engine-db";
import { requirePushSecret } from "@/lib/pipeline-auth";
import {
  BAR_ADJUSTMENTS,
  BAR_FEEDS,
  MAX_BARS_PER_CALL,
  validateBarRow,
  type BarAdjustment,
  type BarFeed,
  type BarRow,
} from "@/lib/shared/engine-bars";

export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const denied = requirePushSecret(req, "daily-bars");
  if (denied) return denied;
  return NextResponse.json({ ok: true, latest: await latestBarDates() });
}

export async function POST(req: NextRequest) {
  const denied = requirePushSecret(req, "daily-bars");
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    feed?: string;
    adjustment?: string;
    source?: string;
    rows?: unknown[];
  };
  const feed = BAR_FEEDS.find((f) => f === body.feed) as BarFeed | undefined;
  const adjustment = BAR_ADJUSTMENTS.find((a) => a === body.adjustment) as BarAdjustment | undefined;
  const source = typeof body.source === "string" && body.source ? body.source : null;
  if (!feed) return NextResponse.json({ error: "feed must be iex or sip" }, { status: 400 });
  if (!adjustment) return NextResponse.json({ error: "adjustment must be split, all or raw" }, { status: 400 });
  if (!source) return NextResponse.json({ error: "source is required" }, { status: 400 });

  const raw = Array.isArray(body.rows) ? body.rows : [];
  if (raw.length > MAX_BARS_PER_CALL) {
    return NextResponse.json({ error: `batch too large: ${raw.length} rows, max ${MAX_BARS_PER_CALL}` }, { status: 413 });
  }

  const rows: BarRow[] = [];
  const rejected: { ticker: string; reason: string }[] = [];
  for (const item of raw) {
    const parsed = validateBarRow(item);
    if (typeof parsed === "string") {
      rejected.push({ ticker: String((item as { ticker?: unknown })?.ticker ?? ""), reason: parsed });
    } else rows.push(parsed);
  }

  try {
    const written = await upsertBars(rows, { feed, adjustment, source });
    return NextResponse.json({ ok: true, written, rejected: rejected.slice(0, 25), rejectedCount: rejected.length });
  } catch (err) {
    console.error(`[daily-bars] write failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
