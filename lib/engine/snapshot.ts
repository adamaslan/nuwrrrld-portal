/**
 * Point-in-time snapshot of one ticker's last bar: the fib ladder, the nearest
 * support/resistance, and every detector hit with the lever values the
 * research loop needs (FIBONACCI.md §11.12). Pure — the batch route persists it.
 */
import { frameLength, type Frame } from "./frame";
import { FibonacciDetector } from "./detectors/fibonacci";
import { IchimokuDetector } from "./detectors/ichimoku";
import { MaCrossDetector } from "./detectors/ma-cross";
import type { Detector } from "./detectors/types";
import { runDetectors } from "./run";
import {
  confluenceZones,
  EXTENSIONS,
  extension,
  GOLDEN_POCKET,
  legRange,
  recentLegs,
  retracement,
  RETRACEMENTS,
  TOLERANCE_ATR_FOR_STOP,
  type FibLeg,
} from "./structure/fib";

export interface SnapshotLevel {
  name: string;
  price: number;
  distance_pct: number;
  strength: string;
  type: "retracement" | "extension";
}

export interface SnapshotZone {
  price: number;
  strength: string;
  signal_count: number;
  confluence_score: number;
}

export interface SnapshotHit {
  detector: string;
  signal: string;
  category: string;
  strength: string;
  description: string;
  experimental: boolean;
  features: Record<string, number | string | boolean | null>;
}

export interface TickerSnapshot {
  close: number;
  atr: number | null;
  legs: FibLeg[];
  levels: SnapshotLevel[];
  zones: SnapshotZone[];
  nearestSupport: number | null;
  nearestResistance: number | null;
  swingAnchor: "confirmed_pivots" | null;
  swingDirection: "up" | "down" | null;
  hits: SnapshotHit[];
  degraded: boolean;
  warnings: string[];
}

/** Golden pocket is the strong level; 0.5/0.786 medium; the rest weak. */
function levelStrength(ratio: number): string {
  if ((GOLDEN_POCKET as readonly number[]).includes(ratio)) return "strong";
  return ratio === 0.5 || ratio === 0.786 ? "medium" : "weak";
}

const ratioName = (ratio: number): string => `Fib ${ratio}`;

function distancePct(price: number, close: number): number {
  return ((price - close) / close) * 100;
}

export function ladderLevels(leg: FibLeg, close: number): SnapshotLevel[] {
  const levels: SnapshotLevel[] = [];
  for (const r of RETRACEMENTS) {
    const price = retracement(leg, r);
    levels.push({
      name: ratioName(r),
      price,
      distance_pct: distancePct(price, close),
      strength: levelStrength(r),
      type: "retracement",
    });
  }
  for (const r of EXTENSIONS) {
    const price = extension(leg, r);
    levels.push({
      name: ratioName(r),
      price,
      distance_pct: distancePct(price, close),
      strength: "medium",
      type: "extension",
    });
  }
  return levels;
}

export function nearestAround(
  levels: readonly SnapshotLevel[],
  close: number,
): { support: number | null; resistance: number | null } {
  let support: number | null = null;
  let resistance: number | null = null;
  for (const { price } of levels) {
    if (price < close && (support === null || price > support)) support = price;
    if (price > close && (resistance === null || price < resistance)) resistance = price;
  }
  return { support, resistance };
}

/** Stop just below the pocket, target at the leg's high — the long-side exit levels. */
export function holdExitLevels(leg: FibLeg, atr: number): { stop: number; target: number } {
  const pocketLow = Math.min(...GOLDEN_POCKET.map((r) => retracement(leg, r)));
  return { stop: pocketLow - TOLERANCE_ATR_FOR_STOP * atr, target: leg.high };
}

function hitFeatures(
  frame: Frame,
  leg: FibLeg,
  signal: string,
): SnapshotHit["features"] {
  const i = frameLength(frame) - 1;
  const atr = frame.atr[i];
  const { open, high, low, close, volume } = {
    open: frame.open[i],
    high: frame.high[i],
    low: frame.low[i],
    close: frame.close[i],
    volume: frame.volume[i],
  };
  const range = high - low;
  const volumeMa = frame.volumeMa20[i];
  const features: SnapshotHit["features"] = {
    leg_low: leg.low,
    leg_high: leg.high,
    leg_is_up: leg.isUp,
    leg_end_index: leg.endIndex,
    atr,
    leg_atr_multiple: atr > 0 ? legRange(leg) / atr : null,
    relative_volume: Number.isFinite(volumeMa) && volumeMa > 0 ? volume / volumeMa : null,
    close_location: range > 0 ? (close - low) / range : null,
    lower_wick: range > 0 ? (Math.min(open, close) - low) / range : null,
    upper_wick: range > 0 ? (high - Math.max(open, close)) / range : null,
    direction: leg.isUp ? "up" : "down",
  };
  if (signal === "FIB GOLDEN POCKET HOLD" && leg.isUp && atr > 0) {
    const { stop, target } = holdExitLevels(leg, atr);
    features.stop = stop;
    features.target = target;
    features.entry = close;
    features.reward_risk = close > stop ? (target - close) / (close - stop) : null;
  }
  return features;
}

export const SNAPSHOT_DETECTORS: readonly Detector[] = [
  new FibonacciDetector(),
  new FibonacciDetector({ experimental: true }),
  // MA/Ichimoku (FIB-ICHIMOKU-MA.md §8 row 5): shadow-only until the 10-day
  // hit-match gate (row 5's own "Done when") is measured in production —
  // that measurement has NOT happened yet, so these stay experimental.
  new MaCrossDetector({ experimental: true }),
  new IchimokuDetector({ experimental: true }),
];

/** Snapshot of the frame's last bar. `detectors` defaults to default + experimental fib/MA/Ichimoku. */
export function snapshotFrame(
  frame: Frame,
  detectors: readonly Detector[] = SNAPSHOT_DETECTORS,
): TickerSnapshot {
  const i = frameLength(frame) - 1;
  const close = frame.close[i];
  const atrValue = frame.atr[i];
  const atr = Number.isFinite(atrValue) ? atrValue : null;
  const legs = atr ? recentLegs(frame.high, frame.low, atr) : [];
  const primary = legs[0];

  const levels = primary ? ladderLevels(primary, close) : [];
  const zones: SnapshotZone[] =
    atr && legs.length > 0
      ? confluenceZones(legs, atr).map((z) => ({
          price: z.price,
          strength: z.legCount >= 2 ? "strong" : "weak",
          signal_count: z.legCount,
          confluence_score: z.legCount,
        }))
      : [];
  const { support, resistance } = nearestAround(levels, close);

  const run = runDetectors(frame, detectors);
  const hits: SnapshotHit[] = run.signals.map((s) => ({
    detector: s.detector,
    signal: s.signal,
    category: s.category,
    strength: s.strength,
    description: s.description,
    experimental: s.detector.endsWith("-experimental"),
    features: primary ? hitFeatures(frame, primary, s.signal) : {},
  }));

  return {
    close,
    atr,
    legs,
    levels,
    zones,
    nearestSupport: support,
    nearestResistance: resistance,
    swingAnchor: primary ? "confirmed_pivots" : null,
    swingDirection: primary ? (primary.isUp ? "up" : "down") : null,
    hits,
    degraded: run.degraded,
    warnings: run.warnings,
  };
}
