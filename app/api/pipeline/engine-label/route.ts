/**
 * POST /api/pipeline/engine-label — write forward-return labels for hits whose
 * horizon has passed. Batched: call until `remaining` is 0.
 * Auth: Bearer PORTAL_PUSH_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_HORIZON_DAYS, labelHit, type HitLabel } from "@/lib/engine";
import { barsAfter, pendingHits, writeLabels } from "@/lib/engine-db";
import { requirePushSecret } from "@/lib/pipeline-auth";

export const maxDuration = 300;

const DEFAULT_BATCH = 200;
const MAX_BATCH = 500;

export async function POST(req: NextRequest) {
  const denied = requirePushSecret(req, "engine-label");
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { horizonDays?: number; limit?: number };
  const horizon = Math.min(252, Math.max(1, Math.floor(Number(body.horizonDays) || DEFAULT_HORIZON_DAYS)));
  const limit = Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(body.limit) || DEFAULT_BATCH)));

  try {
    const pending = await pendingHits(horizon, limit);
    const labels: Array<{ hitId: string; label: HitLabel }> = [];
    for (const hit of pending) {
      const future = await barsAfter(hit.ticker, hit.feed, hit.barDate, horizon);
      const label = labelHit({ entry: hit.entry, stop: hit.stop, target: hit.target, futureBars: future, horizonDays: horizon, side: hit.side });
      if (label) labels.push({ hitId: hit.id, label });
    }
    const written = await writeLabels(labels);
    return NextResponse.json({ ok: true, horizonDays: horizon, examined: pending.length, written, remaining: pending.length === limit });
  } catch (err) {
    console.error(`[engine-label] failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "label run failed" }, { status: 500 });
  }
}
