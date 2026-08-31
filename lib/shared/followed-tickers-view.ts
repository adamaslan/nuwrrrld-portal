/**
 * followed-tickers-view — the pure view-model for the followed-tickers
 * dashboard surface (docs/tickers-followed.md follow-up item 9).
 *
 * Assembles the cohort cards, the horizon scoreboard, and the judge scorecard
 * from the raw DB rows into a single JSON shape that both the Next.js portal
 * page and a future gcp3-mobile screen render. No DB, no React, no formatting
 * beyond rounding — kept pure so the number logic is unit-testable and the two
 * surfaces cannot drift on what "the scoreboard" means.
 */

import {
  aggregate,
  HORIZONS,
  MIN_RESOLVED_FOR_RATE,
  type Direction,
  type Horizon,
  type Outcome,
  type ScoredPick,
} from "@/lib/eval-scoring";

/** One pick as the card renders it. Mirrors `Pick` from followed-tickers-db
 *  plus the derived latest-observation fields. */
export interface CohortCardVM {
  ticker: string;
  direction: Direction;
  addedOn: string;
  entryPrice: number;
  /** Latest close from the observation series, null if none yet. */
  lastPrice: number | null;
  /** Directional return so far, in percent, null until there's a price. */
  directionalReturnPct: number | null;
  /** Today's live signal direction, null when unknown. */
  latestSignal: string | null;
  backtestRatePct: number | null;
  councilOutlook: string | null;
  judgeScore: number | null;
  daysHeld: number | null;
  thesisHolding: boolean;
}

export interface ScoreboardRowVM {
  horizon: Horizon;
  n: number;
  hits: number;
  misses: number;
  flats: number;
  voids: number;
  /** null ⇒ render `n<30` / `not yet available`. */
  hitRatePct: number | null;
  meanReturnPct: number | null;
  /** Horizon not yet reachable for any pick (no scores at all + young cohort). */
  notYetAvailable: boolean;
}

export interface JudgePeriodVM {
  verdictsGraded: number;
  meanScore: number | null;
  criteria: {
    grounding: number | null;
    falsifiability: number | null;
    consistency: number | null;
    specificity: number | null;
    calibration: number | null;
  };
}

export interface FollowedTickersViewVM {
  cohortMonth: string | null;
  /** True when no selection run has populated the cohort yet. */
  empty: boolean;
  bulls: CohortCardVM[];
  bears: CohortCardVM[];
  scoreboard: ScoreboardRowVM[];
  judge: JudgePeriodVM | null;
  /** Diagnostic quadrant counts (outcome × judge≥7). */
  quadrant: {
    hitHighJudge: number;
    missHighJudge: number;
    hitLowJudge: number;
    missLowJudge: number;
  };
  minResolvedForRate: number;
  generatedAt: string;
}

// ── Inputs (the shape the DB layer / route hands in) ─────────────────────────

export interface RawPick {
  id: string;
  cohortMonth: string;
  ticker: string;
  direction: Direction;
  entryPrice: number;
  confidence: "low" | "medium" | "high" | null;
  droppedAt: string | null;
}

export interface RawObservation {
  pickId: string;
  observedOn: string;
  closePrice: number;
  signalDir: string | null;
  backtestRate: number | null;
  councilJson: unknown;
}

export interface RawScore {
  pickId: string;
  horizon: Horizon;
  outcome: Outcome;
  directional: number | null;
  returnPct: number | null;
  judgeScore: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function councilOutlookOf(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const o = (json as Record<string, unknown>).outlook;
  return typeof o === "string" ? o : null;
}

/** Trading days the thesis held: consecutive same-direction observations from
 *  the start until the first disagreement. */
function daysHeldFrom(direction: Direction, obs: readonly RawObservation[]): number {
  const want = direction === "bull" ? "bull" : "bear";
  let held = 0;
  for (const o of obs) {
    const d = o.signalDir?.toLowerCase() ?? "";
    if (!d.includes(want)) break;
    held++;
  }
  return held;
}

function buildCard(pick: RawPick, obs: readonly RawObservation[]): CohortCardVM {
  const sorted = [...obs].sort((a, b) => a.observedOn.localeCompare(b.observedOn));
  const latest = sorted[sorted.length - 1] ?? null;
  const lastPrice = latest?.closePrice ?? null;

  const directionalReturnPct =
    lastPrice != null && pick.entryPrice > 0
      ? round2(
          ((lastPrice - pick.entryPrice) / pick.entryPrice) *
            100 *
            (pick.direction === "bull" ? 1 : -1),
        )
      : null;

  const latestSignal = latest?.signalDir ?? null;
  const thesisHolding =
    latestSignal == null
      ? true
      : latestSignal.toLowerCase().includes(pick.direction === "bull" ? "bull" : "bear");

  return {
    ticker: pick.ticker,
    direction: pick.direction,
    addedOn: pick.cohortMonth,
    entryPrice: pick.entryPrice,
    lastPrice,
    directionalReturnPct,
    latestSignal,
    backtestRatePct: latest?.backtestRate != null ? round1(latest.backtestRate * 100) : null,
    councilOutlook: councilOutlookOf(latest?.councilJson),
    judgeScore: null, // filled from scores below
    daysHeld: sorted.length ? daysHeldFrom(pick.direction, sorted) : null,
    thesisHolding,
  };
}

function buildScoreboard(scores: readonly RawScore[]): ScoreboardRowVM[] {
  const byHorizon = new Map<Horizon, RawScore[]>();
  for (const s of scores) {
    const list = byHorizon.get(s.horizon) ?? [];
    list.push(s);
    byHorizon.set(s.horizon, list);
  }

  return HORIZONS.map((horizon) => {
    const rows = byHorizon.get(horizon) ?? [];
    const scored: ScoredPick[] = rows.map((r) => ({
      outcome: r.outcome,
      directional: r.directional ?? 0,
      returnPct: r.returnPct ?? 0,
    }));
    const agg = aggregate(scored);
    return {
      horizon,
      n: agg.n,
      hits: agg.hits,
      misses: agg.misses,
      flats: agg.flats,
      voids: agg.voids,
      hitRatePct: agg.hitRatePct == null ? null : round1(agg.hitRatePct),
      meanReturnPct: agg.meanDirectionalPct == null ? null : round2(agg.meanDirectionalPct),
      notYetAvailable: rows.length === 0,
    };
  });
}

function buildJudge(scores: readonly RawScore[]): JudgePeriodVM | null {
  const graded = scores.filter((s) => s.judgeScore != null);
  if (graded.length === 0) return null;
  const mean = graded.reduce((sum, s) => sum + (s.judgeScore ?? 0), 0) / graded.length;
  // Per-criterion detail lives in judge_detail jsonb and isn't loaded here;
  // the route can enrich this if/when the criterion breakdown is surfaced.
  return {
    verdictsGraded: graded.length,
    meanScore: round1(mean),
    criteria: {
      grounding: null,
      falsifiability: null,
      consistency: null,
      specificity: null,
      calibration: null,
    },
  };
}

function buildQuadrant(scores: readonly RawScore[]) {
  let hitHighJudge = 0;
  let missHighJudge = 0;
  let hitLowJudge = 0;
  let missLowJudge = 0;
  for (const s of scores) {
    if (s.judgeScore == null) continue;
    if (s.outcome !== "hit" && s.outcome !== "miss") continue;
    const high = s.judgeScore >= 7;
    if (s.outcome === "hit") {
      if (high) hitHighJudge++;
      else hitLowJudge++;
    } else if (high) {
      missHighJudge++;
    } else {
      missLowJudge++;
    }
  }
  return { hitHighJudge, missHighJudge, hitLowJudge, missLowJudge };
}

/**
 * Build the full dashboard view-model. `picks` empty ⇒ `empty: true` and the
 * surface should show the "no selection run yet" state.
 */
export function buildFollowedTickersView(input: {
  picks: readonly RawPick[];
  observationsByPick: Readonly<Record<string, readonly RawObservation[]>>;
  scores: readonly RawScore[];
  now?: Date;
}): FollowedTickersViewVM {
  const { picks, observationsByPick, scores } = input;
  const now = input.now ?? new Date();

  if (picks.length === 0) {
    return {
      cohortMonth: null,
      empty: true,
      bulls: [],
      bears: [],
      scoreboard: buildScoreboard([]),
      judge: null,
      quadrant: { hitHighJudge: 0, missHighJudge: 0, hitLowJudge: 0, missLowJudge: 0 },
      minResolvedForRate: MIN_RESOLVED_FOR_RATE,
      generatedAt: now.toISOString(),
    };
  }

  const latestJudgeByPick = new Map<string, number>();
  for (const s of scores) {
    if (s.judgeScore != null) latestJudgeByPick.set(s.pickId, s.judgeScore);
  }

  const cards = picks.map((p) => {
    const card = buildCard(p, observationsByPick[p.id] ?? []);
    const j = latestJudgeByPick.get(p.id);
    if (j != null) card.judgeScore = j;
    return card;
  });

  const cohortMonth = picks[0]?.cohortMonth ?? null;

  return {
    cohortMonth,
    empty: false,
    bulls: cards.filter((c) => c.direction === "bull"),
    bears: cards.filter((c) => c.direction === "bear"),
    scoreboard: buildScoreboard(scores),
    judge: buildJudge(scores),
    quadrant: buildQuadrant(scores),
    minResolvedForRate: MIN_RESOLVED_FOR_RATE,
    generatedAt: now.toISOString(),
  };
}

/** Human label for a horizon key. */
export const HORIZON_LABEL: Record<Horizon, string> = {
  d1: "1 day",
  w1: "1 week",
  m1: "1 month",
  m3: "3 months",
  m6: "6 months",
  ytd: "Year-to-date",
  y1: "1 year",
};
