/**
 * followed-tickers-db — Neon persistence for the benchmark harness
 * (docs/tickers-followed.md §"Data model"). Three tables:
 *   followed_ticker_picks         — one row per pick, written once at selection
 *   followed_ticker_observations  — daily append, the price series
 *   followed_ticker_scores        — one row per pick per horizon at resolution
 *
 * Unlike the cache stores, a failed write here is *not* silently swallowed:
 * these tables are the eval's system of record, and a dropped observation makes
 * every horizon crossing it unresolvable. Write functions surface errors;
 * read functions return null/[] on failure so a rendering path can degrade.
 */
import sql from "@/lib/db";
import type { Direction, Horizon, Outcome } from "@/lib/eval-scoring";

export interface Pick {
  id: string;
  cohortMonth: string;
  ticker: string;
  direction: Direction;
  entryPrice: number;
  strength: number | null;
  signalCategory: string | null;
  invalidation: string | null;
  confidence: "low" | "medium" | "high" | null;
  selectedAt: string;
  droppedAt: string | null;
  dropReason: string | null;
}

export interface NewPick {
  cohortMonth: string;
  ticker: string;
  direction: Direction;
  entryPrice: number;
  strength?: number | null;
  signalCategory?: string | null;
  invalidation?: string | null;
  confidence?: "low" | "medium" | "high" | null;
}

function rowToPick(r: Record<string, unknown>): Pick {
  return {
    id: r.id as string,
    cohortMonth: new Date(r.cohort_month as string).toISOString().slice(0, 10),
    ticker: r.ticker as string,
    direction: r.direction as Direction,
    entryPrice: Number(r.entry_price),
    strength: r.strength == null ? null : Number(r.strength),
    signalCategory: (r.signal_category as string) ?? null,
    invalidation: (r.invalidation as string) ?? null,
    confidence: (r.confidence as Pick["confidence"]) ?? null,
    selectedAt: new Date(r.selected_at as string).toISOString(),
    droppedAt: r.dropped_at ? new Date(r.dropped_at as string).toISOString() : null,
    dropReason: (r.drop_reason as string) ?? null,
  };
}

/**
 * Insert a whole cohort in one statement. `ON CONFLICT (cohort_month, ticker)
 * DO NOTHING` makes a re-run of the same selection a no-op rather than a
 * duplicate or an error — the pick is frozen once written.
 */
export async function insertCohort(picks: readonly NewPick[]): Promise<Pick[]> {
  if (picks.length === 0) return [];
  const rows = await sql`
    INSERT INTO followed_ticker_picks
      (cohort_month, ticker, direction, entry_price, strength, signal_category, invalidation, confidence)
    SELECT * FROM unnest(
      ${picks.map((p) => p.cohortMonth)}::date[],
      ${picks.map((p) => p.ticker)}::text[],
      ${picks.map((p) => p.direction)}::text[],
      ${picks.map((p) => p.entryPrice)}::numeric[],
      ${picks.map((p) => p.strength ?? null)}::real[],
      ${picks.map((p) => p.signalCategory ?? null)}::text[],
      ${picks.map((p) => p.invalidation ?? null)}::text[],
      ${picks.map((p) => p.confidence ?? null)}::text[]
    ) AS t(cohort_month, ticker, direction, entry_price, strength, signal_category, invalidation, confidence)
    ON CONFLICT (cohort_month, ticker) DO NOTHING
    RETURNING *
  `;
  return rows.map(rowToPick);
}

/** All picks still live (not dropped) whose longest horizon has not yet
 *  resolved. The daily observer iterates these. */
export async function getLivePicks(): Promise<Pick[]> {
  try {
    const rows = await sql`
      SELECT * FROM followed_ticker_picks
      WHERE dropped_at IS NULL
      ORDER BY cohort_month DESC, direction, ticker
    `;
    return rows.map(rowToPick);
  } catch {
    return [];
  }
}

export async function getCohort(cohortMonth: string): Promise<Pick[]> {
  try {
    const rows = await sql`
      SELECT * FROM followed_ticker_picks
      WHERE cohort_month = ${cohortMonth}
      ORDER BY direction, ticker
    `;
    return rows.map(rowToPick);
  } catch {
    return [];
  }
}

/** The most recent cohort_month present, or null if the table is empty. */
export async function getLatestCohortMonth(): Promise<string | null> {
  try {
    const rows = await sql`
      SELECT max(cohort_month) AS m FROM followed_ticker_picks
    `;
    const m = rows[0]?.m;
    return m ? new Date(m as string).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

export async function markPickDropped(
  pickId: string,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE followed_ticker_picks
    SET dropped_at = now(), drop_reason = ${reason}
    WHERE id = ${pickId} AND dropped_at IS NULL
  `;
}

// ── Observations ────────────────────────────────────────────────────────────

export interface Observation {
  pickId: string;
  observedOn: string;
  closePrice: number;
  signalDir: string | null;
  backtestRate: number | null;
  councilJson: unknown;
}

/**
 * Append one trading day's observation for a pick. `ON CONFLICT DO UPDATE` so a
 * same-day re-run corrects the row rather than erroring — the observer is
 * expected to be safely re-runnable. Throws on a real DB failure: a missed
 * observation is a hard failure for this harness.
 */
export async function upsertObservation(obs: Observation): Promise<void> {
  await sql`
    INSERT INTO followed_ticker_observations
      (pick_id, observed_on, close_price, signal_dir, backtest_rate, council_json)
    VALUES (
      ${obs.pickId}, ${obs.observedOn}, ${obs.closePrice},
      ${obs.signalDir}, ${obs.backtestRate},
      ${obs.councilJson == null ? null : JSON.stringify(obs.councilJson)}
    )
    ON CONFLICT (pick_id, observed_on) DO UPDATE SET
      close_price   = EXCLUDED.close_price,
      signal_dir    = EXCLUDED.signal_dir,
      backtest_rate = EXCLUDED.backtest_rate,
      council_json  = EXCLUDED.council_json
  `;
}

/** All observations for a pick, oldest first — the price series outcome
 *  scoring reads to find a horizon's close and to compute days_held. */
export async function getObservations(pickId: string): Promise<
  Array<{ observedOn: string; closePrice: number; signalDir: string | null }>
> {
  try {
    const rows = await sql`
      SELECT observed_on, close_price, signal_dir
      FROM followed_ticker_observations
      WHERE pick_id = ${pickId}
      ORDER BY observed_on ASC
    `;
    return rows.map((r) => ({
      observedOn: new Date(r.observed_on as string).toISOString().slice(0, 10),
      closePrice: Number(r.close_price),
      signalDir: (r.signal_dir as string) ?? null,
    }));
  } catch {
    return [];
  }
}

// ── Scores ─────────────────────────────────────────────────────────────────

export interface HorizonScore {
  pickId: string;
  horizon: Horizon;
  resolvedOn: string;
  exitPrice: number | null;
  returnPct: number | null;
  directional: number | null;
  outcome: Outcome;
}

/**
 * Write (or, for `ytd`, re-write) one pick+horizon score. Every horizon writes
 * once; `ytd` re-resolves daily until Dec 31, so `ON CONFLICT DO UPDATE` is
 * required — and harmless for the write-once horizons.
 */
export async function upsertScore(score: HorizonScore): Promise<void> {
  await sql`
    INSERT INTO followed_ticker_scores
      (pick_id, horizon, resolved_on, exit_price, return_pct, directional, outcome)
    VALUES (
      ${score.pickId}, ${score.horizon}, ${score.resolvedOn},
      ${score.exitPrice}, ${score.returnPct}, ${score.directional}, ${score.outcome}
    )
    ON CONFLICT (pick_id, horizon) DO UPDATE SET
      resolved_on = EXCLUDED.resolved_on,
      exit_price  = EXCLUDED.exit_price,
      return_pct  = EXCLUDED.return_pct,
      directional = EXCLUDED.directional,
      outcome     = EXCLUDED.outcome
  `;
}

/** Which (pick_id, horizon) pairs are already resolved — so the observer can
 *  skip re-resolving write-once horizons. */
export async function getResolvedHorizons(): Promise<Set<string>> {
  try {
    const rows = await sql`
      SELECT pick_id, horizon FROM followed_ticker_scores
    `;
    return new Set(rows.map((r) => `${r.pick_id as string}:${r.horizon as string}`));
  } catch {
    return new Set();
  }
}

export interface ScoreRow extends HorizonScore {
  direction: Direction;
  signalCategory: string | null;
  confidence: "low" | "medium" | "high" | null;
  judgeScore: number | null;
}

/** Every resolved score joined to its pick, for the scoreboard renderer and
 *  the aggregate computation. */
export async function getAllScores(): Promise<ScoreRow[]> {
  try {
    const rows = await sql`
      SELECT s.pick_id, s.horizon, s.resolved_on, s.exit_price, s.return_pct,
             s.directional, s.outcome, s.judge_score,
             p.direction, p.signal_category, p.confidence
      FROM followed_ticker_scores s
      JOIN followed_ticker_picks p ON p.id = s.pick_id
      ORDER BY s.resolved_on DESC
    `;
    return rows.map((r) => ({
      pickId: r.pick_id as string,
      horizon: r.horizon as Horizon,
      resolvedOn: new Date(r.resolved_on as string).toISOString().slice(0, 10),
      exitPrice: r.exit_price == null ? null : Number(r.exit_price),
      returnPct: r.return_pct == null ? null : Number(r.return_pct),
      directional: r.directional == null ? null : Number(r.directional),
      outcome: r.outcome as Outcome,
      direction: r.direction as Direction,
      signalCategory: (r.signal_category as string) ?? null,
      confidence: (r.confidence as ScoreRow["confidence"]) ?? null,
      judgeScore: r.judge_score == null ? null : Number(r.judge_score),
    }));
  } catch {
    return [];
  }
}

/** Recently-resolved scores that still need a judge grade — the weekly judge
 *  run's sample. Only verdicts with a stored council_json can be graded. */
export async function getUnjudgedScoresSince(sinceIso: string): Promise<
  Array<{ pickId: string; horizon: Horizon; councilJson: unknown }>
> {
  try {
    const rows = await sql`
      SELECT s.pick_id, s.horizon, o.council_json
      FROM followed_ticker_scores s
      JOIN followed_ticker_observations o
        ON o.pick_id = s.pick_id AND o.observed_on = (
          SELECT max(observed_on) FROM followed_ticker_observations
          WHERE pick_id = s.pick_id
        )
      WHERE s.judge_score IS NULL
        AND s.resolved_on >= ${sinceIso}
        AND o.council_json IS NOT NULL
    `;
    return rows.map((r) => ({
      pickId: r.pick_id as string,
      horizon: r.horizon as Horizon,
      councilJson: r.council_json,
    }));
  } catch {
    return [];
  }
}

export async function saveJudgeScore(
  pickId: string,
  horizon: Horizon,
  total: number,
  detail: unknown,
  judgeVersion: string,
): Promise<void> {
  await sql`
    UPDATE followed_ticker_scores
    SET judge_score = ${total}, judge_detail = ${JSON.stringify(detail)}, judge_version = ${judgeVersion}
    WHERE pick_id = ${pickId} AND horizon = ${horizon}
  `;
}
