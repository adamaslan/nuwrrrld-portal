/**
 * POST /api/pipeline/followed-tickers — the daily observer.
 *
 * docs/tickers-followed.md §"What runs against them (daily)", follow-up item 3.
 * Called by .github/workflows/track-followed-tickers.yml every trading day at
 * 3:30 PM ET.
 *
 * For each live pick:
 *   1. Append one `followed_ticker_observations` row — close price (from
 *      live_prices), today's signal direction, the backtest hit-rate for the
 *      firing category, and one grounded council verdict (best-effort, free-tier
 *      only). The observation row is the one write that must not be missed; a
 *      gap in the price series makes every horizon crossing it unresolvable.
 *   2. Resolve any fixed-offset horizon that has come due, plus `ytd` (which
 *      re-resolves daily until Dec 31), into `followed_ticker_scores`.
 *
 * Auth: Bearer CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { fetchBacktest } from "@/lib/backtest";
import { buildGroundedBrief } from "@/lib/council-grounding";
import {
  parseStructuredVerdict,
  directionFromOutlook,
} from "@/lib/council-verdict";
import { validateStructuredVerdict } from "@/lib/council-validate";
import { runSeat, seatSystemPrompt, seatPrimaryModel } from "@/lib/openrouter";
import { logPipelineRun, type RunItem } from "@/lib/pipeline-run-log-db";
import { getLivePrice } from "@/lib/live-price-db";
import { fetchTickerEntry } from "@/lib/shared/signal-lookup";
import { scorePick, type Horizon } from "@/lib/eval-scoring";
import {
  dueHorizons,
  tradingDaysBetween,
  ytdIsFinal,
} from "@/lib/shared/followed-tickers-policy";
import {
  getLivePicks,
  getObservations,
  getResolvedHorizons,
  upsertObservation,
  upsertScore,
  type Pick,
} from "@/lib/followed-tickers-db";

export const maxDuration = 300;

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

interface CouncilVerdict {
  direction: string;
  invalidation: string;
  raw: unknown;
  /** Which model actually served the T1 call, for the pipeline run log. */
  model: string;
  latencyMs: number;
  /** True when T1's primary lost and a FREE_MODEL_CHAIN entry served instead. */
  fallback: boolean;
  /** HTTP-200 with an empty completion after the chain was walked — distinct
   *  from a parse failure or a thrown error. */
  empty: boolean;
}

/** One grounded council seat, validated. Returns null on any failure so a
 *  degraded model chain doesn't abort the whole tracking run. The `error` /
 *  `empty` fields let the caller log *why* a ticker produced no verdict. */
async function councilVerdictFor(
  ticker: string,
  apiKey: string,
): Promise<
  | { ok: true; verdict: CouncilVerdict }
  | { ok: false; empty: boolean; model: string | null }
> {
  try {
    const question = `Directional outlook for ${ticker} over the next 1-5 trading days.`;
    const brief = await buildGroundedBrief(question, ticker, "T1");
    // No maxTokens override: runSeat's default (1200) is the documented floor
    // below which the reasoning models in FREE_MODEL_CHAIN spend the whole
    // budget on hidden chain-of-thought and return a 0-character answer, which
    // here surfaced as councilVerdictFor -> null and the ticker being skipped
    // (docs/free-model-rotation-status.md, P3). 500 was under that floor.
    const { answer, model, latencyMs } = await runSeat(
      "T1",
      [
        { role: "system", content: seatSystemPrompt("T1") },
        { role: "user", content: `${brief}\n\n${question}` },
      ],
      apiKey,
    );
    const fallback = model !== seatPrimaryModel("T1");
    const verdict = parseStructuredVerdict(answer);
    if (!verdict) return { ok: false, empty: answer.trim().length === 0, model };
    // Two-layer contract: deterministic validators before anything downstream
    // trusts the verdict. A verdict with a hallucinated number is recorded but
    // flagged so the judge run can exclude it.
    const flags = validateStructuredVerdict(verdict, brief);
    return {
      ok: true,
      verdict: {
        direction: directionFromOutlook(verdict.outlook),
        invalidation: verdict.invalidation,
        raw: { ...verdict, validatorFlags: flags.map((f) => f.message) },
        model,
        latencyMs,
        fallback,
        empty: false,
      },
    };
  } catch (err) {
    // runSeat threw. It uses a distinct message when *every* model returned an
    // empty completion (vs. a hard transport/HTTP failure or a failed brief
    // build) — preserve that distinction so the run log shows "empty" not
    // "fail" for a chain that answered 200-but-blank all the way down.
    const empty = err instanceof Error && /empty completion/i.test(err.message);
    return { ok: false, empty, model: null };
  }
}

/**
 * Resolve every horizon that has come due for a pick against its observation
 * series, writing to followed_ticker_scores. Skips horizons already resolved
 * (except ytd, which is re-resolved until year end).
 */
async function resolveDueHorizons(
  pick: Pick,
  observations: Array<{ observedOn: string; closePrice: number }>,
  alreadyResolved: Set<string>,
  now: Date,
): Promise<Horizon[]> {
  if (observations.length === 0) return [];
  const entryDate = new Date(pick.selectedAt);
  const elapsed = tradingDaysBetween(entryDate, now);
  const resolved: Horizon[] = [];

  const candidates: Horizon[] = [...dueHorizons(elapsed)];
  // ytd is always a candidate once a calendar year has been crossed; it
  // re-resolves in place until it becomes final on Dec 31.
  const crossedYear = now.getUTCFullYear() > entryDate.getUTCFullYear() ||
    (now.getUTCMonth() === 11 && now.getUTCDate() === 31);
  if (crossedYear) candidates.push("ytd");

  for (const horizon of candidates) {
    const key = `${pick.id}:${horizon}`;
    const ytdFinal = horizon === "ytd" && ytdIsFinal(entryDate, now);
    // Skip write-once horizons already done; for ytd, keep re-resolving until final.
    if (alreadyResolved.has(key) && (horizon !== "ytd" || ytdFinal)) continue;

    // The horizon's close is the last observation at or before its due date.
    // For fixed-offset horizons we approximate the due date by trading-day
    // count from entry; for ytd it's the latest observation of the entry year
    // (or the final one on/after Dec 31).
    const exitObs =
      horizon === "ytd"
        ? [...observations]
            .reverse()
            .find((o) => new Date(o.observedOn).getUTCFullYear() === entryDate.getUTCFullYear()) ??
          observations[observations.length - 1]
        : observations[observations.length - 1];
    if (!exitObs) continue;

    const scored = scorePick({
      direction: pick.direction,
      entryPrice: pick.entryPrice,
      exitPrice: exitObs.closePrice,
      horizon,
      void: pick.droppedAt != null,
    });

    await upsertScore({
      pickId: pick.id,
      horizon,
      resolvedOn: exitObs.observedOn,
      exitPrice: exitObs.closePrice,
      returnPct: scored.returnPct,
      directional: scored.directional,
      outcome: scored.outcome,
    });
    resolved.push(horizon);
  }
  return resolved;
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
  const today = now.toISOString().slice(0, 10);
  const readings: Reading[] = [];
  const runItems: RunItem[] = [];
  let missedObservations = 0;
  let councilDegraded = 0;

  for (const pick of picks) {
    const lp = await getLivePrice(pick.ticker);
    const close = lp && lp.price > 0 ? lp.price : null;

    // Today's signal direction, for the days_held count and the thesis-flip check.
    const liveEntry = await fetchTickerEntry(pick.ticker);
    const liveSignalDir = liveEntry?.ai_action ? String(liveEntry.ai_action) : null;

    const backtestRate = await backtestRateFor(pick.ticker, pick.signalCategory);
    const councilResult = apiKey ? await councilVerdictFor(pick.ticker, apiKey) : null;
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

    if (close == null) {
      missedObservations++;
    } else if (!dryRun) {
      await upsertObservation({
        pickId: pick.id,
        observedOn: today,
        closePrice: close,
        signalDir: normLive,
        backtestRate,
        councilJson: council?.raw ?? null,
      });
    }

    let resolved: Horizon[] = [];
    if (!dryRun) {
      const observations = await getObservations(pick.id);
      resolved = await resolveDueHorizons(pick, observations, alreadyResolved, now);
    }

    readings.push({
      ticker: pick.ticker,
      direction: pick.direction,
      close,
      signalDir: normLive,
      backtestRate,
      council: council ? { direction: council.direction } : null,
      thesisHolding,
      resolved,
    });
  }

  const backtestAvailable = readings.some((r) => r.backtestRate != null);
  const horizonsResolved = readings.reduce((n, r) => n + r.resolved.length, 0);

  // Best-effort model-usage audit row (docs/model-usage/). Never fatal.
  const runLogged = await logPipelineRun({
    pipeline: "followed-tickers",
    dryRun,
    session: body.session ?? null,
    itemsTotal: picks.length,
    items: runItems,
    summary: {
      cohortSize: picks.length,
      missedObservations,
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
      degraded: councilDegraded,
      backtest_available: backtestAvailable,
      horizonsResolved,
      runLogged,
    },
  });
}
