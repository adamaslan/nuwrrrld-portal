/**
 * Forward-return labels for a hit: return at the horizon, direction-correct,
 * and the triple-barrier outcome when the hit defined a stop and a target.
 * Pure. Returns null until enough future bars exist to decide.
 */
import type { Bar } from "./frame";

export const DEFAULT_HORIZON_DAYS = 21;

export interface HitLabel {
  horizonDays: number;
  pctReturn: number;
  /** Direction-correct at the horizon close (return > 0 for longs). */
  hit: boolean;
  outcome: "target" | "stop" | "time" | null;
  rMultiple: number | null;
}

export interface LabelInput {
  entry: number;
  stop?: number | null;
  target?: number | null;
  /** Bars strictly after the hit's bar, oldest first. */
  futureBars: readonly Bar[];
  horizonDays?: number;
}

/**
 * Long-side labeling. When one bar reaches both barriers the stop wins — the
 * conservative reading, since intrabar order is unknowable from daily bars.
 */
export function labelHit(input: LabelInput): HitLabel | null {
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const { entry, stop, target, futureBars } = input;
  if (!(entry > 0) || futureBars.length < horizon) return null;

  const window = futureBars.slice(0, horizon);
  const hasBarriers = stop != null && target != null && stop < entry && target > entry;

  let outcome: HitLabel["outcome"] = null;
  let exitPrice = window[window.length - 1].close;
  if (hasBarriers) {
    outcome = "time";
    for (const bar of window) {
      if (bar.low <= stop) {
        outcome = "stop";
        exitPrice = stop;
        break;
      }
      if (bar.high >= target) {
        outcome = "target";
        exitPrice = target;
        break;
      }
    }
  }

  const pctReturn = ((exitPrice - entry) / entry) * 100;
  const risk = hasBarriers ? entry - stop : null;
  return {
    horizonDays: horizon,
    pctReturn,
    hit: pctReturn > 0,
    outcome,
    rMultiple: risk && risk > 0 ? (exitPrice - entry) / risk : null,
  };
}
