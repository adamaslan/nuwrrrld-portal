/**
 * Public, aggregate view of the Followed Tickers scoreboard.
 *
 * Counts only: no tickers, prices, cohort membership or per-user data leave
 * this module, so the result is safe to render on an unauthenticated page.
 * Misses, flats and voids are reported next to hits for every horizon. A
 * hit-rate is withheld below MIN_RESOLVED_FOR_RATE decisive calls, the same
 * rule the signed-in scoreboard uses (see eval-scoring.ts).
 *
 * Pure and import-safe: the DB reader lives in public-track-record-db.ts so
 * this file can be unit-tested without a database connection.
 */
import {
  aggregate,
  HORIZONS,
  MIN_RESOLVED_FOR_RATE,
  type Horizon,
  type Outcome,
  type ScoredPick,
} from "@/lib/eval-scoring";

export const HORIZON_LABEL: Record<Horizon, string> = {
  d1: "1 day",
  w1: "1 week",
  m1: "1 month",
  m3: "3 months",
  m6: "6 months",
  ytd: "Year to date",
  y1: "1 year",
};

export interface ScoreInput {
  horizon: Horizon;
  outcome: Outcome;
  directional: number | null;
  resolvedOn: string;
}

export interface HorizonRecord {
  horizon: Horizon;
  label: string;
  /** Hits + misses: the denominator of the rate. */
  decisive: number;
  hits: number;
  misses: number;
  flats: number;
  voids: number;
  /** null while decisive < MIN_RESOLVED_FOR_RATE. */
  hitRatePct: number | null;
  meanDirectionalPct: number | null;
}

export interface PublicTrackRecord {
  horizons: HorizonRecord[];
  /** Every scored row across horizons, including flats and voids. */
  totalScored: number;
  latestResolvedOn: string | null;
  minForRate: number;
}

export function buildPublicTrackRecord(rows: readonly ScoreInput[]): PublicTrackRecord | null {
  if (rows.length === 0) return null;

  const byHorizon = new Map<Horizon, ScoredPick[]>();
  let latest: string | null = null;
  for (const r of rows) {
    const directional = r.directional ?? 0;
    const list = byHorizon.get(r.horizon) ?? [];
    list.push({ outcome: r.outcome, returnPct: directional, directional });
    byHorizon.set(r.horizon, list);
    if (latest === null || r.resolvedOn > latest) latest = r.resolvedOn;
  }

  const horizons: HorizonRecord[] = [];
  for (const horizon of HORIZONS) {
    const scored = byHorizon.get(horizon);
    if (!scored) continue;
    const a = aggregate(scored);
    horizons.push({
      horizon,
      label: HORIZON_LABEL[horizon],
      decisive: a.n,
      hits: a.hits,
      misses: a.misses,
      flats: a.flats,
      voids: a.voids,
      hitRatePct: a.hitRatePct,
      meanDirectionalPct: a.meanDirectionalPct,
    });
  }

  return {
    horizons,
    totalScored: rows.length,
    latestResolvedOn: latest,
    minForRate: MIN_RESOLVED_FOR_RATE,
  };
}
