/**
 * Point-in-time Fibonacci legs, levels and confluence zones — a port of
 * signals-app indicators/fibonacci.py. Pure math; no signals are built here.
 *
 * Anchors are confirmed pivots, never window extremes, and retracements are
 * measured from the leg's far end, so up-legs and down-legs are
 * direction-aware: 0.618 of an up-leg 100→200 is 138.2, of a down-leg 161.8.
 */
import { precomputePivots, type Pivot } from "./pivots";

export const RETRACEMENTS = [0.382, 0.5, 0.618, 0.65, 0.786] as const;
export const EXTENSIONS = [1.272, 1.618] as const;
export const GOLDEN_POCKET = [0.618, 0.65] as const;
export const BREAK_RATIO = 0.786;
export const TARGET_RATIO = 1.618;
export const MIN_LEG_ATR = 3.0;
export const ZONE_ATR = 0.5;
export const MAX_LEGS = 3;
/** Stop sits this many ATRs below the pocket's low (matches the detector's hold tolerance). */
export const TOLERANCE_ATR_FOR_STOP = 0.25;
const PIVOT_POOL = 60;

export interface FibLeg {
  low: number;
  high: number;
  /** True when the low pivot precedes the high pivot. */
  isUp: boolean;
  /** Bar index of the leg's later pivot. */
  endIndex: number;
}

export function legRange(leg: FibLeg): number {
  return leg.high - leg.low;
}

/** Price at `ratio` retracement, measured back from the leg's end. */
export function retracement(leg: FibLeg, ratio: number): number {
  return leg.isUp ? leg.high - ratio * legRange(leg) : leg.low + ratio * legRange(leg);
}

/** Price at `ratio` extension of the leg, in the leg's direction. */
export function extension(leg: FibLeg, ratio: number): number {
  return leg.isUp ? leg.low + ratio * legRange(leg) : leg.high - ratio * legRange(leg);
}

/** Collapse runs of same-kind pivots, keeping the most extreme of each run. */
function alternatingPivots(pivots: readonly Pivot[]): Pivot[] {
  const merged: Pivot[] = [];
  for (const pivot of pivots) {
    const prev = merged[merged.length - 1];
    if (prev && prev.kind === pivot.kind) {
      const moreExtreme =
        pivot.kind === "resistance" ? pivot.price > prev.price : pivot.price < prev.price;
      if (moreExtreme) merged[merged.length - 1] = pivot;
      continue;
    }
    merged.push(pivot);
  }
  return merged;
}

/**
 * Most-recent-first legs between alternating confirmed pivots. Legs smaller
 * than MIN_LEG_ATR × atr are skipped: tiny legs put levels a few cents apart
 * and price touches all of them.
 */
export function recentLegs(
  high: readonly number[],
  low: readonly number[],
  atr: number,
  maxLegs: number = MAX_LEGS,
): FibLeg[] {
  if (!(atr > 0)) return [];
  const pivots = alternatingPivots(precomputePivots(high, low, undefined, PIVOT_POOL));
  const legs: FibLeg[] = [];
  for (let k = pivots.length - 1; k >= 1; k--) {
    const earlier = pivots[k - 1];
    const later = pivots[k];
    // A wide outside bar can be both pivot high and low; that "leg" has no swing.
    if (earlier.barIndex === later.barIndex) continue;
    const isUp = later.kind === "resistance";
    const [legLow, legHigh] = isUp ? [earlier.price, later.price] : [later.price, earlier.price];
    if (legHigh - legLow < MIN_LEG_ATR * atr) continue;
    legs.push({ low: legLow, high: legHigh, isUp, endIndex: later.barIndex });
    if (legs.length === maxLegs) break;
  }
  return legs;
}

export interface ConfluenceZone {
  price: number;
  /** Independent legs with a retracement in this zone. */
  legCount: number;
}

/** Retracements from all legs, chained into zones where neighbours are within ZONE_ATR × atr. */
export function confluenceZones(legs: readonly FibLeg[], atr: number): ConfluenceZone[] {
  if (!(atr > 0)) return [];
  const points: Array<[number, number]> = [];
  legs.forEach((leg, legIndex) => {
    for (const r of RETRACEMENTS) points.push([retracement(leg, r), legIndex]);
  });
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const zones: ConfluenceZone[] = [];
  let cluster: Array<[number, number]> = [];
  for (const point of points) {
    if (cluster.length > 0 && point[0] - cluster[cluster.length - 1][0] > ZONE_ATR * atr) {
      zones.push(summarise(cluster));
      cluster = [];
    }
    cluster.push(point);
  }
  if (cluster.length > 0) zones.push(summarise(cluster));
  return zones;
}

function summarise(cluster: ReadonlyArray<[number, number]>): ConfluenceZone {
  let sum = 0;
  for (const [price] of cluster) sum += price;
  return { price: sum / cluster.length, legCount: new Set(cluster.map(([, i]) => i)).size };
}
