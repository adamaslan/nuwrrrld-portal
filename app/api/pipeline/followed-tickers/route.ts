/**
 * POST /api/pipeline/followed-tickers — the daily observer.
 *
 * docs/tickers-followed.md §"What runs against them (daily)", follow-up item 3.
 * Called by .github/workflows/track-followed-tickers.yml every trading day after
 * the 4:00 PM ET close (GitHub's cron fires about 7:00 PM ET).
 *
 * For each live pick:
 *   1. Append one `followed_ticker_observations` row — close price (from the
 *      followed-tickers price chain), today's signal direction, the backtest
 *      hit-rate for the firing category, and one grounded council verdict
 *      (best-effort, free-tier only). The observation row is the one write that
 *      must not be missed; a gap in the price series makes every horizon
 *      crossing it unresolvable. A pick already observed today is skipped, so a
 *      second fire of the track window makes no duplicate council calls.
 *   2. Resolve any fixed-offset horizon that has come due, plus `ytd` (which
 *      re-resolves daily until Dec 31), into `followed_ticker_scores`. Each
 *      horizon exits on its own trading-day offset, never on the latest close.
 *
 * Auth: Bearer CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { fetchBacktest } from "@/lib/backtest";
import { logPipelineRun, type RunItem } from "@/lib/pipeline-run-log-db";
import { councilVerdictFor, resolveDueHorizons } from "@/lib/followed-tickers-run";
import { resolveFollowedPrice, nyDateOf, type FollowedPrice } from "@/lib/followed-tickers-price";
import type { Horizon } from "@/lib/eval-scoring";
import { fetchTickerEntry } from "@/lib/shared/signal-lookup";
import {
  getLivePicks,
  getObservations,
  getPickIdsObservedOn,
  getResolvedHorizons,
  upsertObservation,
  insertObservationClose,
  type Pick,
} from "@/lib/followed-tickers-db";

export const maxDuration = 300;

/** Picks processed in parallel. The council call is a free-model round trip
 *  (seconds to tens of seconds with fallbacks); serial over a 20-pick cohort
 *  ran past maxDuration and 504ed every run since the gate was fixed. */
const PICK_CONCURRENCY = 4;
/** Stop starting new picks this long after the handler began, leaving the rest
 *  of maxDuration for in-flight calls and the run log. Applies separately to
 *  mandatory observations first, then optional enrichment. Deferrals are explicit. */
const PICK_START_BUDGET_MS = 210_000;
/** Hard stop for optional council calls, measured from handler start. Past it
 *  the council is skipped (or abandoned) so in-flight picks cannot hold
 *  Promise.all past maxDuration; the observation is already written by then. */
const COUNCIL_DEADLINE_MS = 270_000;

interface Reading {
  ticker: string;
  direction: "bull" | "bear";
  close: number | null;
  signalDir: string | null;
  backtestRate: number | null;
  council: { direction: string } | null;
  thesisHolding: boolean | null;
  resolved: Horizon[];
}

/** Backtest hit-rate for whichever category is currently firing for a ticker,
 *  or null when the engine is disabled / has no bucket for it. */
async function backtestRateFor(
  ticker: string,
  signalCategory: string | null,
): Promise<number | null> {
  const bt = await fetchBacktest(ticker);
  if (!bt) return null;
  const buckets = bt.by_category ?? [];
  if (buckets.length === 0) return null;
  const match =
    (signalCategory &&
      buckets.find((b) => b.key.toLowerCase() === signalCategory.toLowerCase())) ||
    buckets[0];
  return match ? match.hit_rate : null;
}

/**
 * Cron entrypoint for the followed-tickers tracking run. Bearer-authed. For
 * each pick it resolves any due horizons, pulls a grounded council verdict
 * (degrading gracefully when the model chain is unhealthy), and records one
 * pipeline-run-log item per pick that reached a model. Writes a best-effort
 * model-usage audit row (docs/model-usage/) that is never fatal to the run.
 * Accepts `{ dry_run?: boolean; session?: string }`.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[followed-track] CONFIG_ERROR: CRON_SECRET is not set.");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();

  const body = (await req.json().catch(() => ({}))) as {
    dry_run?: boolean;
    session?: string;
  };
  const dryRun = body.dry_run === true;
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";

  const picks = await getLivePicks();
  if (picks.length === 0) {
    // A successful run that happened to have no work is still an invocation —
    // record a zero-item row so the usage report's "one row per run" holds and
    // a quiet day is visible, not just absent.
    const runLogged = await logPipelineRun({
      pipeline: "followed-tickers",
      dryRun,
      session: body.session ?? null,
      itemsTotal: 0,
      items: [],
      summary: { cohortSize: 0, note: "no live cohort" },
    });
    return NextResponse.json({
      ok: true,
      readings: [],
      meta: { note: "no live cohort — run followed-tickers-select first", runLogged },
    });
  }

  const alreadyResolved = await getResolvedHorizons();
  const now = new Date();
  // The observer is keyed by NY trading day. A UTC date would run a day ahead
  // after the 19:00 ET track run and stamp observations onto the next day.
  const today = nyDateOf(now);
  const observedToday = await getPickIdsObservedOn(today, { strict: true });
  const readings: Reading[] = [];
  const runItems: RunItem[] = [];
  let missedObservations = 0;
  let councilDegraded = 0;
  let alreadyObserved = 0;
  let deferred = 0;

  const captured = new Map<string, { price: FollowedPrice | null; resolved: Horizon[]; readingIndex: number }>();
  let observationDeferred = 0;
  let observationFailed = 0;
  let enrichmentFailed = 0;
  let horizonRetryFailed = 0;
  let horizonRetryDeferred = 0;
  let horizonsRetried = 0;
  let retriedHorizonsResolved = 0;
  let enriched = 0;

  // Complete required close observations and due-horizon resolution across the
  // cohort before any signal/backtest enrichment or optional council work.
  const observePick = async (pick: Pick): Promise<void> => {
    const price = await resolveFollowedPrice(pick.ticker, { freshSince: today, closedOn: today });
    if (price == null) missedObservations++;
    if (price != null && !dryRun) {
      // Non-destructive on conflict: never erase existing signal/backtest/
      // council context if this same-day row already carries it.
      await insertObservationClose({ pickId: pick.id, observedOn: today,
        closePrice: price.price, priceSource: price.source });
    }
    // Record the saved close before horizon resolution: a horizon failure
    // keeps the mandatory-failure status but must not drop the close from
    // the response or from enrichment.
    const entry = { price, resolved: [] as Horizon[], readingIndex: readings.length };
    captured.set(pick.id, entry);
    readings.push({ ticker: pick.ticker, direction: pick.direction,
      close: price?.price ?? null, signalDir: null, backtestRate: null,
      council: null, thesisHolding: null, resolved: entry.resolved });
    if (!dryRun) {
      entry.resolved = await resolveDueHorizons(pick, await getObservations(pick.id, { strict: true }), alreadyResolved, now);
      readings[entry.readingIndex].resolved = entry.resolved;
    }
  };

  const processPick = async (pick: Pick): Promise<void> => {

    // The observer runs after the close: a pre-close print must never become
    // the day's close, because the same-day skip would then keep it.
    const { price, resolved, readingIndex } = captured.get(pick.id)!;
    const close = price?.price ?? null;

    // Today's signal direction, for the days_held count and the thesis-flip check.
    const liveEntry = await fetchTickerEntry(pick.ticker);
    const liveSignalDir = liveEntry?.ai_action ? String(liveEntry.ai_action) : null;

    const backtestRate = await backtestRateFor(pick.ticker, pick.signalCategory);

    // Enrich the already-saved required observation with optional fields.
    const liveDir = liveSignalDir
      ? liveSignalDir.toLowerCase().includes("buy")
        ? "bull"
        : liveSignalDir.toLowerCase().includes("sell")
          ? "bear"
          : null
      : null;
    if (price != null && !dryRun) {
      await upsertObservation({
        pickId: pick.id,
        observedOn: today,
        closePrice: price.price,
        priceSource: price.source,
        signalDir: liveDir,
        backtestRate,
        councilJson: null,
      });
    }

    const councilMsLeft = COUNCIL_DEADLINE_MS - (Date.now() - startedAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The race limits waiting, not provider execution. Late work may finish;
    // it cannot write into this route after the timeout wins.
    const councilResult = apiKey && councilMsLeft > 0
      ? await Promise.race([
          councilVerdictFor(pick.ticker, apiKey),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), councilMsLeft); }),
        ]).finally(() => { if (timer !== undefined) clearTimeout(timer); })
      : null;
    const council = councilResult?.ok ? councilResult.verdict : null;
    if (apiKey && !council) councilDegraded++;

    // One run-log item per pick that reached the model (or tried to).
    if (councilResult) {
      runItems.push(
        councilResult.ok
          ? {
              subject: pick.ticker,
              seat: "T1",
              model: councilResult.verdict.model,
              outcome: "ok",
              latencyMs: councilResult.verdict.latencyMs,
              fallback: councilResult.verdict.fallback,
            }
          : {
              subject: pick.ticker,
              seat: "T1",
              model: councilResult.model,
              outcome: councilResult.empty ? "empty" : "fail",
            },
      );
    }

    // thesis holding? — the live signal direction vs. the picked direction.
    const normLive = liveSignalDir
      ? liveSignalDir.toLowerCase().includes("buy")
        ? "bull"
        : liveSignalDir.toLowerCase().includes("sell")
          ? "bear"
          : null
      : council
        ? council.direction === "bullish"
          ? "bull"
          : council.direction === "bearish"
            ? "bear"
            : null
        : null;
    const thesisHolding = normLive == null ? null : normLive === pick.direction;

    if (price != null && !dryRun && (council || normLive !== liveDir)) {
      await upsertObservation({
        pickId: pick.id,
        observedOn: today,
        closePrice: price.price,
        priceSource: price.source,
        signalDir: normLive,
        backtestRate,
        councilJson: council?.raw ?? null,
      });
    }

    enriched++;
    readings[readingIndex] = {
      ticker: pick.ticker,
      direction: pick.direction,
      close,
      signalDir: normLive,
      backtestRate,
      council: council ? { direction: council.direction } : null,
      thesisHolding,
      resolved,
    };
  };

  const pending = picks.filter((pick) => {
    if (!observedToday.has(pick.id)) return true;
    alreadyObserved++;
    return false;
  });
  let observationIndex = 0;
  const observationWorker = async (): Promise<void> => {
    while (observationIndex < pending.length) {
      if (Date.now() - startedAt > PICK_START_BUDGET_MS) {
        observationDeferred += pending.length - observationIndex;
        observationIndex = pending.length;
        return;
      }
      const pick = pending[observationIndex++];
      try { await observePick(pick); } catch { observationFailed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PICK_CONCURRENCY, pending.length) }, observationWorker));
  // Retry only deterministic horizon resolution for already-observed picks.
  // Do not refetch prices, upsert context or repeat model calls.
  for (const pick of picks.filter(p => !dryRun && observedToday.has(p.id))) {
    if (Date.now() - startedAt > PICK_START_BUDGET_MS) { horizonRetryDeferred++; continue; }
    try {
      const resolved = await resolveDueHorizons(pick, await getObservations(pick.id, { strict: true }), alreadyResolved, now);
      horizonsRetried++;
      retriedHorizonsResolved += resolved.length;
    } catch { horizonRetryFailed++; }
  }
  const enrichmentPending = pending.filter((p) => captured.has(p.id));
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < enrichmentPending.length) {
      if (Date.now() - startedAt > PICK_START_BUDGET_MS) {
        deferred += enrichmentPending.length - nextIndex;
        nextIndex = enrichmentPending.length;
        return;
      }
      const pick = enrichmentPending[nextIndex++];
      try { await processPick(pick); } catch { enrichmentFailed++; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PICK_CONCURRENCY, enrichmentPending.length) }, worker));

  const backtestAvailable = readings.some((r) => r.backtestRate != null);
  const horizonsResolved = retriedHorizonsResolved + readings.reduce((n, r) => n + r.resolved.length, 0);

  // Best-effort model-usage audit row (docs/model-usage/). Never fatal.
  const runLogged = await logPipelineRun({
    pipeline: "followed-tickers",
    dryRun,
    session: body.session ?? null,
    itemsTotal: picks.length,
    items: runItems,
    status: missedObservations || observationDeferred || observationFailed || enrichmentFailed || horizonRetryFailed || horizonRetryDeferred || deferred || councilDegraded ? "partial" : "ok",
    summary: {
      cohortSize: picks.length,
      missedObservations,
      observationDeferred,
      observationFailed,
      enrichmentFailed,
      enriched,
      horizonsRetried,
      horizonRetryFailed,
      horizonRetryDeferred,
      mandatoryComplete: !(missedObservations || observationDeferred || observationFailed || horizonRetryFailed || horizonRetryDeferred),
      status: missedObservations || observationDeferred || observationFailed || enrichmentFailed || horizonRetryFailed || horizonRetryDeferred || deferred || councilDegraded ? "partial" : "ok",
      alreadyObserved,
      deferred,
      councilDegraded,
      backtestAvailable,
      horizonsResolved,
    },
  });

  return NextResponse.json({
    ok: true,
    dryRun,
    session: body.session ?? null,
    readings,
    meta: {
      cohortSize: picks.length,
      missedObservations,
      observationDeferred,
      observationFailed,
      enrichmentFailed,
      enriched,
      horizonsRetried,
      horizonRetryFailed,
      horizonRetryDeferred,
      mandatoryComplete: !(missedObservations || observationDeferred || observationFailed || horizonRetryFailed || horizonRetryDeferred),
      status: missedObservations || observationDeferred || observationFailed || enrichmentFailed || horizonRetryFailed || horizonRetryDeferred || deferred || councilDegraded ? "partial" : "ok",
      alreadyObserved,
      deferred,
      degraded: councilDegraded,
      backtest_available: backtestAvailable,
      horizonsResolved,
      runLogged,
    },
  });
}
