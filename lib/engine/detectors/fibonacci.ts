/**
 * Fibonacci detector — a port of signals-app detection/fibonacci.py.
 *
 * Fires only on a reaction on the last bar (a hold, a break, a target hit),
 * never on proximity to a level. By default only the best-measured signal is
 * emitted: a bullish 0.618–0.65 hold on above-average volume (+1.2 pts over
 * the 21-day baseline, z = 1.8, full universe — see homebase
 * harness/FIBONACCI.md §4). Everything else needs `experimental: true`.
 */
import { frameLength, type Frame } from "../frame";
import { formatFixed2 } from "../format";
import {
  BREAK_RATIO,
  confluenceZones,
  extension,
  GOLDEN_POCKET,
  recentLegs,
  retracement,
  TARGET_RATIO,
  type FibLeg,
} from "../structure/fib";
import type { Detector, EngineSignal, SignalStrength } from "./types";

export const MIN_BARS = 30;
export const TOLERANCE_ATR = 0.25;
export const MIN_CONFLUENCE_LEGS = 2;
export const MAX_SIGNALS_PER_BAR = 2;
export const FIBONACCI_CATEGORY = "FIBONACCI";

interface BarValues {
  high: number;
  low: number;
  open: number;
  close: number;
}

const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);

function signal(label: string, description: string, strength: SignalStrength): EngineSignal {
  return { signal: label, description, strength, category: FIBONACCI_CATEGORY };
}

/** rank 0..2 → BULLISH..EXTREME, mirrored for down-legs. */
function graded(leg: FibLeg, rank: 0 | 1 | 2): SignalStrength {
  const bull: SignalStrength[] = ["BULLISH", "STRONG BULLISH", "EXTREME BULLISH"];
  const bear: SignalStrength[] = ["BEARISH", "STRONG BEARISH", "EXTREME BEARISH"];
  return (leg.isUp ? bull : bear)[rank];
}

/**
 * Touched the zone this bar and closed back out of it in the leg's direction.
 * The bar's extreme must stay within zone ± tolerance: trading clean through
 * the zone and closing back is a breach, not a hold.
 */
function reacted(leg: FibLeg, zoneLo: number, zoneHi: number, tol: number, bar: BarValues): boolean {
  if (leg.isUp) {
    const touched = zoneLo - tol <= bar.low && bar.low <= zoneHi + tol;
    return touched && bar.close > zoneHi && bar.close > bar.open;
  }
  const touched = zoneLo - tol <= bar.high && bar.high <= zoneHi + tol;
  return touched && bar.close < zoneLo && bar.close < bar.open;
}

function goldenPocketHold(leg: FibLeg, tol: number, bar: BarValues, heavy: boolean): EngineSignal | null {
  const prices = GOLDEN_POCKET.map((r) => retracement(leg, r));
  const zoneLo = Math.min(...prices);
  const zoneHi = Math.max(...prices);
  if (!reacted(leg, zoneLo, zoneHi, tol, bar)) return null;
  const side = leg.isUp ? "support" : "resistance";
  return signal(
    "FIB GOLDEN POCKET HOLD",
    `Reacted at 0.618-0.65 ${side} ${formatFixed2(zoneLo)}-${formatFixed2(zoneHi)}`,
    graded(leg, heavy ? 1 : 0),
  );
}

function confluenceHold(
  legs: readonly FibLeg[],
  leg: FibLeg,
  atr: number,
  tol: number,
  bar: BarValues,
  heavy: boolean,
): EngineSignal | null {
  for (const zone of confluenceZones(legs, atr)) {
    if (zone.legCount < MIN_CONFLUENCE_LEGS) continue;
    if (reacted(leg, zone.price, zone.price, tol, bar)) {
      return signal(
        "FIB CONFLUENCE HOLD",
        `Reacted at ${zone.legCount}-leg Fibonacci confluence near ${formatFixed2(zone.price)}`,
        graded(leg, heavy ? 2 : 1),
      );
    }
  }
  return null;
}

function breakSignal(leg: FibLeg, close: number, prevClose: number): EngineSignal | null {
  const level = retracement(leg, BREAK_RATIO);
  if (leg.isUp && close < level && level <= prevClose) {
    return signal("FIB 0.786 BREAK", `Closed below 0.786 retracement ${formatFixed2(level)}`, "BEARISH");
  }
  if (!leg.isUp && close > level && level >= prevClose) {
    return signal("FIB 0.786 BREAK", `Closed above 0.786 retracement ${formatFixed2(level)}`, "BULLISH");
  }
  return null;
}

function targetSignal(leg: FibLeg, bar: BarValues, prevHigh: number, prevLow: number): EngineSignal | null {
  const level = extension(leg, TARGET_RATIO);
  const reached = leg.isUp
    ? bar.high >= level && level > prevHigh
    : bar.low <= level && level < prevLow;
  if (!reached) return null;
  // SIGNIFICANT, not BEARISH: fib categories aren't in signals-app's up-trend
  // extension gate, so a bearish tag would vote against uptrends ungated.
  return signal("FIB 1.618 TARGET", `Reached 1.618 extension ${formatFixed2(level)}`, "SIGNIFICANT");
}

export class FibonacciDetector implements Detector {
  readonly name: string;
  private readonly experimental: boolean;

  constructor(options: { experimental?: boolean } = {}) {
    this.experimental = options.experimental ?? false;
    this.name = this.experimental ? "fibonacci-experimental" : "fibonacci";
  }

  detect(frame: Frame): EngineSignal[] {
    const n = frameLength(frame);
    if (n < MIN_BARS) return [];
    const i = n - 1;
    const atr = frame.atr[i];
    const bar: BarValues = { high: frame.high[i], low: frame.low[i], open: frame.open[i], close: frame.close[i] };
    const prevClose = frame.close[i - 1];
    const prevHigh = frame.high[i - 1];
    const prevLow = frame.low[i - 1];
    if (!finite(atr) || atr === 0) return [];
    if (![bar.high, bar.low, bar.open, bar.close, prevClose, prevHigh, prevLow].every(finite)) return [];

    const legs = recentLegs(frame.high, frame.low, atr);
    if (legs.length === 0) return [];

    const leg = legs[0];
    const tol = TOLERANCE_ATR * atr;
    const volume = frame.volume[i];
    const volumeMa = frame.volumeMa20[i];
    const aboveAverageVolume = finite(volume) && finite(volumeMa) && volume > volumeMa;

    if (!this.experimental) {
      const hold = goldenPocketHold(leg, tol, bar, true);
      return hold && leg.isUp && aboveAverageVolume ? [hold] : [];
    }

    const signals: EngineSignal[] = [];
    const hold =
      confluenceHold(legs, leg, atr, tol, bar, aboveAverageVolume) ??
      goldenPocketHold(leg, tol, bar, aboveAverageVolume);
    if (hold) signals.push(hold);
    const broke = breakSignal(leg, bar.close, prevClose);
    if (broke) signals.push(broke);
    const target = targetSignal(leg, bar, prevHigh, prevLow);
    if (target) signals.push(target);
    return signals.slice(0, MAX_SIGNALS_PER_BAR);
  }
}
