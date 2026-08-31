/**
 * followed-tickers-policy — pure selection + horizon-resolution policy for the
 * monthly benchmark cohort (docs/tickers-followed.md §"How the cohort is
 * chosen"). No DB, no network — unit-testable without DATABASE_URL, same as
 * universe-policy.ts.
 */

import type { Direction, Horizon } from "@/lib/eval-scoring";
import { HORIZON_TRADING_DAYS } from "@/lib/eval-scoring";

/** Default picks per side. The doc freezes 10 bear + 10 bull. */
export const COHORT_SIDE_SIZE = 10;

/** A card the selection run ranks. Shape is the subset of `/api/signals/top`'s
 *  card that selection actually needs. */
export interface RankableCard {
  ticker: string;
  /** Free-text direction label — "bullish"/"bearish"/"neutral" or "bull"/"bear".
   *  Anything not matching bull/bear is treated as an absent directional signal. */
  direction: string;
  /** Signed signal score in [-100, 100]; positive is bullish. "Strength" for
   *  ranking purposes is `abs(score)` — the strongest bear is the most negative. */
  score: number;
  /** History depth — the first tie-breaker. Optional; absent falls through to
   *  the alphabetical tie-break. */
  barsScanned?: number;
}

export interface CohortPick {
  ticker: string;
  direction: Direction;
  strength: number;
}

/** Map a card's free-text direction onto the pick enum, or null if it is not a
 *  usable directional signal. A measured-negative is a real bear signal; an
 *  *absent* one is not (concept-three-state-signal). */
export function pickDirection(cardDirection: string): Direction | null {
  const d = cardDirection.toLowerCase();
  if (d.includes("bull")) return "bull";
  if (d.includes("bear")) return "bear";
  return null;
}

/**
 * Split the ranked universe by direction, take the top `sideSize` by strength
 * from each side. Ties broken by bars_scanned (more history first), then
 * alphabetically — deterministic, so re-running selection on the same ranking
 * yields the same cohort.
 */
export function selectCohort(
  cards: readonly RankableCard[],
  sideSize: number = COHORT_SIDE_SIZE,
): { bulls: CohortPick[]; bears: CohortPick[] } {
  const bulls: CohortPick[] = [];
  const bears: CohortPick[] = [];

  for (const card of cards) {
    const dir = pickDirection(card.direction);
    if (!dir) continue;
    // strength is the ranking magnitude — abs(score) — so both sides sort
    // "strongest first" with the same comparator.
    const pick: CohortPick = {
      ticker: card.ticker,
      direction: dir,
      strength: Math.abs(card.score),
    };
    (dir === "bull" ? bulls : bears).push(pick);
  }

  const byStrength = (a: CohortPick, b: CohortPick, cards: readonly RankableCard[]) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    const barsA = cards.find((c) => c.ticker === a.ticker)?.barsScanned ?? 0;
    const barsB = cards.find((c) => c.ticker === b.ticker)?.barsScanned ?? 0;
    if (barsB !== barsA) return barsB - barsA;
    return a.ticker.localeCompare(b.ticker);
  };

  bulls.sort((a, b) => byStrength(a, b, cards));
  bears.sort((a, b) => byStrength(a, b, cards));

  return { bulls: bulls.slice(0, sideSize), bears: bears.slice(0, sideSize) };
}

/** First-of-month for a given date, in UTC — the `cohort_month` key. */
export function cohortMonthOf(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

/**
 * Which fixed-offset horizons have come due for a pick, given how many trading
 * days have elapsed since its entry. `ytd` is excluded — it is calendar-anchored
 * and the caller resolves it separately every run until Dec 31.
 */
export function dueHorizons(tradingDaysElapsed: number): Exclude<Horizon, "ytd">[] {
  return (Object.keys(HORIZON_TRADING_DAYS) as Exclude<Horizon, "ytd">[]).filter(
    (h) => tradingDaysElapsed >= HORIZON_TRADING_DAYS[h],
  );
}

/** True once the current date is on or past Dec 31 of the pick's entry year —
 *  i.e. the `ytd` horizon has reached its final resolution and stops
 *  re-resolving. Before that, `ytd` is partial and re-stated daily. */
export function ytdIsFinal(entryDate: Date, now: Date): boolean {
  const yearEnd = Date.UTC(entryDate.getUTCFullYear(), 11, 31);
  return now.getTime() >= yearEnd;
}

/** Count trading days (Mon–Fri, holidays not excluded — the observation series
 *  is the source of truth for actual market days; this is only used to decide
 *  which horizons to *attempt* to resolve). */
export function tradingDaysBetween(start: Date, end: Date): number {
  if (end <= start) return 0;
  let count = 0;
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur < last) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}
