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
  /** Direction-correct at the horizon close: return > 0 for longs, < 0 for shorts. */
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
  /** 1 for a bullish hit (default), -1 for a bearish one. */
  side?: 1 | -1;
}

/** Strengths that state a direction. SIGNIFICANT and NEUTRAL do not, so they have no label. */
export const DIRECTIONAL_STRENGTHS = [
  "BULLISH", "STRONG BULLISH", "EXTREME BULLISH",
  "BEARISH", "STRONG BEARISH", "EXTREME BEARISH",
] as const;

export const sideForStrength = (strength: string): 1 | -1 | null => {
  if (!(DIRECTIONAL_STRENGTHS as readonly string[]).includes(strength)) return null;
  return strength.endsWith("BEARISH") ? -1 : 1;
};

/**
 * Direction-aware labeling (long by default). A short has its stop above entry
 * and its target below. When one bar reaches both barriers the stop wins — the
 * conservative reading, since intrabar order is unknowable from daily bars.
 */
export function labelHit(input: LabelInput): HitLabel | null {
  const horizon = input.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const { entry, stop, target, futureBars } = input;
  const side = input.side ?? 1;
  if (!(entry > 0) || futureBars.length < horizon) return null;

  const window = futureBars.slice(0, horizon);
  const hasBarriers =
    stop != null && target != null && (side === 1 ? stop < entry && target > entry : stop > entry && target < entry);

  let outcome: HitLabel["outcome"] = null;
  let exitPrice = window[window.length - 1].close;
  if (hasBarriers) {
    outcome = "time";
    for (const bar of window) {
      if (side === 1 ? bar.low <= stop : bar.high >= stop) {
        outcome = "stop";
        exitPrice = stop;
        break;
      }
      if (side === 1 ? bar.high >= target : bar.low <= target) {
        outcome = "target";
        exitPrice = target;
        break;
      }
    }
  }

  const pctReturn = ((exitPrice - entry) / entry) * 100;
  const risk = hasBarriers ? side * (entry - stop) : null;
  return {
    horizonDays: horizon,
    pctReturn,
    hit: side * pctReturn > 0,
    outcome,
    rMultiple: risk && risk > 0 ? (side * (exitPrice - entry)) / risk : null,
  };
}
