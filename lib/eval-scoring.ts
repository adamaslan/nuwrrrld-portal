/**
 * eval-scoring — pure outcome math for the followed-tickers benchmark
 * (docs/tickers-followed.md §"Scoring: outcome accuracy").
 *
 * No DB, no network, no dates-from-now. Everything here is reproducible from a
 * pick's frozen (entry_price, direction) plus a horizon close price. Kept pure
 * and dependency-free on purpose: a scoring bug is invisible — it produces
 * plausible numbers — so it has to be exhaustively unit-testable without a DB.
 */

export type Direction = "bull" | "bear";
export type Horizon = "d1" | "w1" | "m1" | "m3" | "m6" | "ytd" | "y1";
export type Outcome = "hit" | "miss" | "flat" | "void";

export const HORIZONS: readonly Horizon[] = ["d1", "w1", "m1", "m3", "m6", "ytd", "y1"] as const;

/**
 * Dead-band τ per horizon, in percent. ±0.5% in a day and ±0.5% in a year are
 * not the same claim, so τ scales with the horizon — a fixed band would make
 * long horizons look far more accurate than they are (any drift eventually
 * exceeds a small band). Values are the doc's, verbatim.
 */
export const DEAD_BAND_PCT: Record<Horizon, number> = {
  d1: 0.5,
  w1: 1,
  m1: 2,
  m3: 3,
  m6: 5,
  ytd: 5,
  y1: 8,
};

/** Trading days from the frozen entry to each horizon's resolution. `ytd` is
 *  calendar-anchored (Dec 31), not offset-anchored, so it has no entry here. */
export const HORIZON_TRADING_DAYS: Record<Exclude<Horizon, "ytd">, number> = {
  d1: 1,
  w1: 5,
  m1: 21,
  m3: 63,
  m6: 126,
  y1: 252,
};

/** A hit-rate over fewer than this many resolved picks is not reported as a
 *  rate — publishing one is the single easiest way to make the harness lie. */
export const MIN_RESOLVED_FOR_RATE = 30;

/** Raw percent return of the price move, direction-agnostic. */
export function returnPct(entryPrice: number, exitPrice: number): number {
  if (!(entryPrice > 0)) return 0;
  return ((exitPrice - entryPrice) / entryPrice) * 100;
}

/**
 * Signed return in the direction of the call: a bear call profits when price
 * falls, so its directional return is the negated raw return.
 */
export function directionalReturn(
  entryPrice: number,
  exitPrice: number,
  direction: Direction,
): number {
  const raw = returnPct(entryPrice, exitPrice);
  return direction === "bull" ? raw : -raw;
}

/**
 * Classify one resolved pick against its horizon's dead band.
 * `void` is never produced here — it is a data-availability verdict the caller
 * sets (delisted / halted / price gap), handled before this function runs.
 */
export function classifyOutcome(directional: number, horizon: Horizon): Exclude<Outcome, "void"> {
  const tau = DEAD_BAND_PCT[horizon];
  if (directional > tau) return "hit";
  if (directional < -tau) return "miss";
  return "flat";
}

export interface ResolvedPick {
  direction: Direction;
  entryPrice: number;
  exitPrice: number;
  horizon: Horizon;
  /** Set by the caller when the pick is unresolvable (delisted/halted/gap). */
  void?: boolean;
}

export interface ScoredPick {
  outcome: Outcome;
  returnPct: number;
  directional: number;
}

export function scorePick(pick: ResolvedPick): ScoredPick {
  if (pick.void) {
    return { outcome: "void", returnPct: 0, directional: 0 };
  }
  const raw = returnPct(pick.entryPrice, pick.exitPrice);
  const directional = pick.direction === "bull" ? raw : -raw;
  return {
    outcome: classifyOutcome(directional, pick.horizon),
    returnPct: raw,
    directional,
  };
}

export interface Aggregate {
  n: number; // hits + misses — the rate's denominator
  hits: number;
  misses: number;
  flats: number;
  voids: number;
  /** null when n < MIN_RESOLVED_FOR_RATE — the doc's `n<30 — insufficient`. */
  hitRatePct: number | null;
  /** Mean directional return across hits + misses (flats/voids excluded). */
  meanDirectionalPct: number | null;
}

/**
 * Aggregate a set of scored picks into a hit-rate with its denominator.
 * Flats are counted and reported, never silently dropped — a strategy that is
 * 70% accurate on 10 decisive calls out of 200 is a different object from one
 * that is 70% accurate on 190.
 */
export function aggregate(scored: readonly ScoredPick[]): Aggregate {
  let hits = 0;
  let misses = 0;
  let flats = 0;
  let voids = 0;
  let directionalSum = 0;

  for (const s of scored) {
    switch (s.outcome) {
      case "hit":
        hits++;
        directionalSum += s.directional;
        break;
      case "miss":
        misses++;
        directionalSum += s.directional;
        break;
      case "flat":
        flats++;
        break;
      case "void":
        voids++;
        break;
    }
  }

  const n = hits + misses;
  return {
    n,
    hits,
    misses,
    flats,
    voids,
    hitRatePct: n >= MIN_RESOLVED_FOR_RATE ? (hits / n) * 100 : null,
    meanDirectionalPct: n > 0 ? directionalSum / n : null,
  };
}

// ── Baselines ────────────────────────────────────────────────────────────────
// A hit-rate without a baseline is uninterpretable. Each baseline is computed
// over the *identical* picks and horizons as the strategy it is compared to.

export interface BaselineInput {
  direction: Direction;
  entryPrice: number;
  exitPrice: number;
  /** Same entry/exit dates, SPY substituted. */
  spyEntryPrice: number;
  spyExitPrice: number;
  horizon: Horizon;
  void?: boolean;
  /** The backtest_hit_rates figure for this pick's firing category, 0..1. */
  backtestPrior?: number | null;
}

export interface Baselines {
  coinFlipPct: number;
  /** Every pick scored as if bullish — catches bull-market drift. */
  alwaysLongPct: number | null;
  /** SPY over the same dates — did ticker selection add anything? */
  buyHoldSpyPct: number | null;
  /** Mean of the per-pick backtest priors — is the live signal like its history? */
  backtestPriorPct: number | null;
}

export function computeBaselines(rows: readonly BaselineInput[]): Baselines {
  const live = rows.filter((r) => !r.void);

  // Always-long: score every pick as a bull call, same dead band.
  const alwaysLong = aggregate(
    live.map((r) => scorePick({ ...r, direction: "bull" })),
  );

  // Buy-and-hold SPY: a bull "call" on SPY over the same window, same dead band.
  const spy = aggregate(
    live.map((r) =>
      scorePick({
        direction: "bull",
        entryPrice: r.spyEntryPrice,
        exitPrice: r.spyExitPrice,
        horizon: r.horizon,
      }),
    ),
  );

  const priors = live
    .map((r) => r.backtestPrior)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));

  return {
    coinFlipPct: 50,
    alwaysLongPct: alwaysLong.hitRatePct,
    buyHoldSpyPct: spy.hitRatePct,
    backtestPriorPct:
      priors.length > 0
        ? (priors.reduce((a, b) => a + b, 0) / priors.length) * 100
        : null,
  };
}

/** Trading days a thesis survived before its live signal first disagreed with
 *  the picked direction. Counts consecutive same-direction observations from
 *  the entry; the first disagreement stops the count. */
export function daysHeld(
  pickDirection: Direction,
  observationDirs: readonly (string | null | undefined)[],
): number {
  let held = 0;
  const want = pickDirection === "bull" ? "bull" : "bear";
  for (const d of observationDirs) {
    const norm =
      typeof d === "string" && d.toLowerCase().includes(want) ? want : null;
    if (norm !== want) break;
    held++;
  }
  return held;
}
