/**
 * POST /api/pipeline/engine-run — compute fib structure and detector hits for a
 * chunk of the active universe from stored bars. Chunked by offset/limit; chunks
 * of one run share `runId` and add to one engine_runs row.
 *
 * mode=shadow (default) writes only engine_* tables. mode=live also folds the
 * fib ladder into ticker_cards.numerics and is refused (403) unless
 * ENGINE_LIVE_ENABLED=true. Never calls a model.
 * Auth: Bearer PORTAL_PUSH_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildFrame, ENGINE_CODE_VERSION } from "@/lib/engine";
import { snapshotFrame } from "@/lib/engine/snapshot";
import {
  bumpRun,
  countEngineTickers,
  listEngineTickers,
  loadSeries,
  mergeCardFibNumerics,
  startRun,
  writeHits,
  writeSnapshots,
  type HitWrite,
  type SnapshotWrite,
} from "@/lib/engine-db";
import { requirePushSecret } from "@/lib/pipeline-auth";
import { BAR_FEEDS, isIsoDate, type BarFeed } from "@/lib/shared/engine-bars";
import { engineLiveEnabled } from "@/lib/shared/engine-ladder";

export const maxDuration = 300;

const BARS_PER_TICKER = 300;
const MIN_BARS = 60;
const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 1000;
/** A series whose last bar is older than this many days is a delisted or stalled ticker. */
const MAX_STALE_DAYS = 6;

const daysBetween = (a: string, b: string): number => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;

export async function POST(req: NextRequest) {
  const denied = requirePushSecret(req, "engine-run");
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as {
    runId?: string;
    mode?: string;
    feed?: string;
    offset?: number;
    limit?: number;
    asOf?: string;
  };
  // Live mode writes user-facing card numerics, so it stays off until the
  // promotion checklist is approved. Separate from ENGINE_LADDER_ENABLED.
  if (body.mode === "live" && !engineLiveEnabled()) {
    return NextResponse.json({ error: "live mode is not enabled" }, { status: 403 });
  }
  const mode = body.mode === "live" ? "live" : "shadow";
  const feed = (BAR_FEEDS.find((f) => f === body.feed) ?? "iex") as BarFeed;
  const offset = Math.max(0, Math.floor(Number(body.offset) || 0));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(body.limit) || DEFAULT_LIMIT)));
  const runId = typeof body.runId === "string" && /^[\w.:-]{1,80}$/.test(body.runId) ? body.runId : `engine-${Date.now()}`;
  const asOf = isIsoDate(body.asOf) ? body.asOf : new Date().toISOString().slice(0, 10);

  try {
    const [tickers, total] = await Promise.all([listEngineTickers(offset, limit), countEngineTickers()]);
    await startRun(runId, { codeVersion: ENGINE_CODE_VERSION, mode, feed });
    const series = await loadSeries(tickers, feed, BARS_PER_TICKER);
    const bySymbol = new Map(series.map((s) => [s.ticker, s]));

    const snapshots: SnapshotWrite[] = [];
    const hits: HitWrite[] = [];
    let skipped = 0;
    let failed = 0;
    let degraded = 0;
    let latestBar: string | null = null;

    for (const ticker of tickers) {
      const s = bySymbol.get(ticker);
      const barDate = s?.dates[s.dates.length - 1];
      if (!s || !barDate || s.bars.length < MIN_BARS || daysBetween(barDate, asOf) > MAX_STALE_DAYS) {
        skipped += 1;
        continue;
      }
      try {
        const snapshot = snapshotFrame(buildFrame(s.bars));
        if (snapshot.degraded) degraded += 1;
        snapshots.push({ ticker, barDate, snapshot });
        for (const h of snapshot.hits) hits.push({ ...h, ticker, barDate });
        if (!latestBar || barDate > latestBar) latestBar = barDate;
      } catch (err) {
        failed += 1;
        console.error(`[engine-run] ${ticker} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const meta = { codeVersion: ENGINE_CODE_VERSION, runId };
    await writeSnapshots(snapshots, meta);
    await writeHits(hits, meta);
    if (mode === "live") await mergeCardFibNumerics(snapshots);
    await bumpRun(runId, { ok: snapshots.length, skipped, failed, degraded, hits: hits.length, barDate: latestBar });

    const next = offset + tickers.length;
    return NextResponse.json({
      ok: true,
      runId,
      mode,
      processed: tickers.length,
      written: snapshots.length,
      skipped,
      failed,
      degraded,
      hits: hits.length,
      nextOffset: next < total ? next : null,
      total,
    });
  } catch (err) {
    console.error(`[engine-run] failed: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "engine run failed" }, { status: 500 });
  }
}
