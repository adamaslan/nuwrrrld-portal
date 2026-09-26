/**
 * fib-levels — the Fibonacci slice of the holdfold /analyze response, plus the
 * pure ladder derivation the UI renders. Shapes mirror holdemfoldemapp's
 * backend/core.py (FibLevel, fib_confluence_zones, nearest_fib_*) exactly, so
 * web and mobile can share one contract instead of each guessing.
 */

export interface FibLevel {
  name: string;
  price: number;
  distance_pct: number;
  strength: string;
  type: string;
}

export interface FibConfluenceZone {
  price: number;
  strength: string;
  signal_count: number;
  confluence_score: number;
}

export interface FibSummary {
  fib_levels?: FibLevel[];
  fib_confluence_zones?: FibConfluenceZone[];
  nearest_fib_support?: number | null;
  nearest_fib_resistance?: number | null;
}

export type FibLadderRow =
  | { kind: "level"; name: string; price: number; distancePct: number }
  | { kind: "price"; price: number };

export interface FibLadder {
  /** Rows highest price first, with the current-price marker in place. */
  rows: FibLadderRow[];
  support: { price: number; distancePct: number } | null;
  resistance: { price: number; distancePct: number } | null;
  zones: FibConfluenceZone[];
}

export const MAX_LADDER_LEVELS = 6;
export const MAX_LADDER_ZONES = 3;

/** A usable level: finite, and a distance above -100% (at or below that the
 *  implied spot price is infinite or negative, so the level is corrupt). */
function isFiniteLevel(level: FibLevel): boolean {
  return (
    Number.isFinite(level.price) &&
    Number.isFinite(level.distance_pct) &&
    level.distance_pct > -100
  );
}

/** The backend sends no spot price, but each level carries its distance from
 *  it: price = level / (1 + distance/100). Any level gives the same answer. */
function impliedPrice(level: FibLevel): number {
  return level.price / (1 + level.distance_pct / 100);
}

/**
 * Build the ladder from a holdfold response. Returns null when there is
 * nothing to draw, so callers can hide the section instead of rendering an
 * empty box. Keeps only the levels nearest to price: the backend's list is in
 * registry order, not proximity order.
 */
export function buildFibLadder(summary: FibSummary): FibLadder | null {
  const levels = (summary.fib_levels ?? []).filter(isFiniteLevel);
  if (levels.length === 0) return null;

  const spot = impliedPrice(levels[0]);
  if (!Number.isFinite(spot) || spot <= 0) return null;
  const nearest = [...levels]
    .sort((a, b) => Math.abs(a.distance_pct) - Math.abs(b.distance_pct))
    .slice(0, MAX_LADDER_LEVELS);

  const rows: FibLadderRow[] = nearest.map((l) => ({
    kind: "level" as const,
    name: l.name,
    price: l.price,
    distancePct: l.distance_pct,
  }));
  rows.push({ kind: "price", price: spot });
  rows.sort((a, b) => b.price - a.price);

  const distanceOf = (price: number | null | undefined) => {
    if (price == null) return null;
    const match = levels.find((l) => l.price === price);
    return { price, distancePct: match ? match.distance_pct : ((price - spot) / spot) * 100 };
  };

  const zones = [...(summary.fib_confluence_zones ?? [])]
    .sort((a, b) => b.confluence_score - a.confluence_score)
    .slice(0, MAX_LADDER_ZONES);

  return {
    rows,
    support: distanceOf(summary.nearest_fib_support),
    resistance: distanceOf(summary.nearest_fib_resistance),
    zones,
  };
}
