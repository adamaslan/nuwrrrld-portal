/**
 * POST /api/pipeline/followed-tickers-select — monthly cohort selection.
 *
 * docs/tickers-followed.md §"How the cohort is chosen (monthly)", follow-up
 * item 2. Called by .github/workflows/select-followed-tickers.yml on the 1st of
 * each month.
 *
 * Ranks the signal universe via `topCards()`, splits by direction, takes the
 * 10 strongest bulls + 10 strongest bears (deterministic tie-breaks in
 * lib/shared/followed-tickers-policy.ts), stamps each with an entry price from
 * live_prices, and freezes them into `followed_ticker_picks`. The pick tuple —
 * (ticker, direction, entry_price, strength, signal_category) — is the
 * benchmark item and is never updated after this.
 *
 * Auth: Bearer CRON_SECRET (not PORTAL_PUSH_SECRET — the workflow sends
 * CRON_SECRET, per the doc's "Secrets required").
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { getLivePrice } from "@/lib/live-price-db";
import { topCards } from "@/lib/ticker-cards-db";
import {
  resolveHorizon,
  resolveUniverseScope,
} from "@/lib/shared/universe-policy";
import {
  COHORT_SIDE_SIZE,
  cohortMonthOf,
  selectCohort,
  type RankableCard,
} from "@/lib/shared/followed-tickers-policy";
import {
  getCohort,
  insertCohort,
  type NewPick,
} from "@/lib/followed-tickers-db";
import { renderCohort, type CohortRow } from "@/lib/followed-tickers-render";

export const maxDuration = 300;

/** Rank enough of the universe that both sides can be filled after neutral
 *  cards are discarded, without pulling the whole table. */
const RANK_LIMIT = 200;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[followed-select] CONFIG_ERROR: CRON_SECRET is not set.");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    universe?: string;
    count?: number;
    dry_run?: boolean;
  };
  const scope = resolveUniverseScope(body.universe);
  const horizon = resolveHorizon("t1");
  const sideSize = Math.max(1, Math.min(COHORT_SIDE_SIZE, Number(body.count) || COHORT_SIDE_SIZE));
  const dryRun = body.dry_run === true;

  const cohortMonth = cohortMonthOf(new Date());

  // Re-selection guard: the cohort is frozen for the month. If one already
  // exists for this cohort_month, return it and do nothing — a manual
  // re-dispatch must not re-pick.
  const existing = await getCohort(cohortMonth);
  if (existing.length > 0) {
    return NextResponse.json({
      ok: true,
      cohortMonth,
      alreadyFrozen: true,
      bulls: existing.filter((p) => p.direction === "bull").map((p) => p.ticker),
      bears: existing.filter((p) => p.direction === "bear").map((p) => p.ticker),
    });
  }

  const cards = await topCards(horizon, RANK_LIMIT, scope);
  if (cards.length === 0) {
    return NextResponse.json(
      { ok: false, cohortMonth, error: "no ranked cards available — cannot select a cohort" },
      { status: 503 },
    );
  }

  const rankable: RankableCard[] = cards.map((c) => ({
    ticker: c.ticker,
    direction: String(c.tokens?.direction ?? ""),
    score: typeof c.score === "number" ? c.score : 0,
  }));

  const { bulls, bears } = selectCohort(rankable, sideSize);
  const chosen = [...bulls, ...bears];

  // Stamp entry prices. A pick with no live price is dropped from the cohort
  // rather than frozen with a guessed entry — the entry price is load-bearing
  // for every horizon and cannot be reconstructed later.
  const priced: NewPick[] = [];
  const skipped: string[] = [];
  for (const pick of chosen) {
    const lp = await getLivePrice(pick.ticker);
    if (!lp || !(lp.price > 0)) {
      skipped.push(pick.ticker);
      continue;
    }
    const card = cards.find((c) => c.ticker === pick.ticker);
    priced.push({
      cohortMonth,
      ticker: pick.ticker,
      direction: pick.direction,
      entryPrice: lp.price,
      strength: pick.strength,
      signalCategory: card?.stateKey ?? card?.tokens?.direction ?? null,
      invalidation: null, // filled by the first daily council run
      confidence: null,
    });
  }

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      cohortMonth,
      dryRun: true,
      bulls: priced.filter((p) => p.direction === "bull").map((p) => p.ticker),
      bears: priced.filter((p) => p.direction === "bear").map((p) => p.ticker),
      skippedNoPrice: skipped,
    });
  }

  const inserted = await insertCohort(priced);

  // The route runs on a read-only serverless FS and cannot edit the doc itself.
  // It returns the rendered *Current cohort* section so the workflow's commit
  // step can splice it between the FT:COHORT markers (see
  // lib/followed-tickers-render.ts `replaceSection`).
  const cohortRows: CohortRow[] = inserted.map((p) => ({
    ticker: p.ticker,
    direction: p.direction,
    added: p.cohortMonth,
    entry: p.entryPrice,
    latestSignal: "—",
    backtest: "—",
    council: "—",
    judge: null,
    daysHeld: null,
    thesisHolding: true,
  }));

  return NextResponse.json({
    ok: true,
    cohortMonth,
    universe: scope,
    frozen: inserted.length,
    bulls: inserted.filter((p) => p.direction === "bull").map((p) => p.ticker),
    bears: inserted.filter((p) => p.direction === "bear").map((p) => p.ticker),
    skippedNoPrice: skipped,
    renderedCohort: renderCohort(cohortRows, `${cohortMonth} (${inserted.length} picks)`),
  });
}
