/**
 * Confirmed swing pivots — a port of signals-app indicators/pivots.py.
 *
 * Bar i is a pivot high when its High is the maximum of bars i−window..i+window
 * and that span isn't flat (pivot low: same with Low). So a pivot at bar j is
 * only known once bar j + window exists; that lag is what keeps levels from
 * repainting.
 */

export const PIVOT_WINDOW = 3;
export const MAX_PIVOT_LEVELS = 20;

export type PivotKind = "support" | "resistance";

export interface Pivot {
  price: number;
  barIndex: number;
  kind: PivotKind;
}

export function precomputePivots(
  high: readonly number[],
  low: readonly number[],
  window: number = PIVOT_WINDOW,
  maxLevels: number = MAX_PIVOT_LEVELS,
): Pivot[] {
  const n = high.length;
  if (n < window * 2 + 1) return [];

  const levels: Pivot[] = [];
  for (let i = window; i < n - window; i++) {
    let segHighMax = -Infinity;
    let segHighMin = Infinity;
    let segLowMax = -Infinity;
    let segLowMin = Infinity;
    for (let j = i - window; j <= i + window; j++) {
      if (high[j] > segHighMax) segHighMax = high[j];
      if (high[j] < segHighMin) segHighMin = high[j];
      if (low[j] > segLowMax) segLowMax = low[j];
      if (low[j] < segLowMin) segLowMin = low[j];
    }
    // Python appends resistance before support for the same bar; keep that order.
    if (high[i] === segHighMax && high[i] > segHighMin) {
      levels.push({ price: high[i], barIndex: i, kind: "resistance" });
    }
    if (low[i] === segLowMin && low[i] < segLowMax) {
      levels.push({ price: low[i], barIndex: i, kind: "support" });
    }
  }
  // Generated in bar order already, which is what Python's stable sort yields.
  return levels.slice(-maxLevels);
}
