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
import { runSeat, seatSystemPrompt } from "@/lib/openrouter";
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

/** One grounded council seat, validated. Returns null on any failure so a
 *  degraded model chain doesn't abort the whole tracking run. */
async function councilVerdictFor(
  ticker: string,
  apiKey: string,
): Promise<{ direction: string; invalidation: string; raw: unknown } | null> {
  try {
    const question = `Directional outlook for ${ticker} over the next 1-5 trading days.`;
    const brief = await buildGroundedBrief(question, ticker, "T1");
    const { answer } = await runSeat(
      "T1",
      [
        { role: "system", content: seatSystemPrompt("T1") },
        { role: "user", content: `${brief}\n\n${question}` },
      ],
      apiKey,
      500,
    );
    const verdict = parseStructuredVerdict(answer);
    if (!verdict) return null;
    // Two-layer contract: deterministic validators before anything downstream
    // trusts the verdict. A verdict with a hallucinated number is recorded but
    // flagged so the judge run can exclude it.
    const flags = validateStructuredVerdict(verdict, brief);
    return {
      direction: directionFromOutlook(verdict.outlook),
      invalidation: verdict.invalidation,
      raw: { ...verdict, validatorFlags: flags.map((f) => f.message) },
    };
  } catch {
    return null;
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
    return NextResponse.json({
      ok: true,
      readings: [],
      meta: { note: "no live cohort — run followed-tickers-select first" },
    });
  }

  const alreadyResolved = await getResolvedHorizons();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const readings: Reading[] = [];
  let missedObservations = 0;
  let councilDegraded = 0;

  for (const pick of picks) {
    const lp = await getLivePrice(pick.ticker);
    const close = lp && lp.price > 0 ? lp.price : null;

    // Today's signal direction, for the days_held count and the thesis-flip check.
    const liveEntry = await fetchTickerEntry(pick.ticker);
    const liveSignalDir = liveEntry?.ai_action ? String(liveEntry.ai_action) : null;

    const backtestRate = await backtestRateFor(pick.ticker, pick.signalCategory);
    const council = apiKey ? await councilVerdictFor(pick.ticker, apiKey) : null;
    if (apiKey && !council) councilDegraded++;

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
      horizonsResolved: readings.reduce((n, r) => n + r.resolved.length, 0),
    },
  });
}
