/**
 * universe-policy — pure, dependency-free decision logic for reading the
 * ranked ticker-card universe.
 *
 * Split from `lib/ticker-cards-db.ts` for the same reason `signal-policy.ts`
 * is split from `signal-lookup.ts`: everything here is unit-testable without
 * `DATABASE_URL`, which `@/lib/db` throws on at import time. Nothing in this
 * file does I/O. If a function needs the DB, it belongs in `ticker-cards-db`.
 *
 * The thresholds live here rather than inline in the route so that "what
 * counts as a strong card" is one edit in one place, and so a change to it
 * shows up in a test diff rather than only in a query.
 */

import type { CardAction, CardUniverse } from "./card-policy";
import type { Horizon } from "../grounding/taxonomy";

/** Default page size for a top-N read. */
export const DEFAULT_TOP_LIMIT = 50;

/** Hard cap on a single request. The ranking index makes a large LIMIT cheap
 *  in Postgres, but the JSON response is not free to serialize or transfer,
 *  and no UI has a use for more than this in one page. */
export const MAX_TOP_LIMIT = 200;

/** Score at or above which a card is worth surfacing unprompted.
 *  Deliberately above `actionFromScore`'s BUY line (35): "this is a BUY" and
 *  "this is worth interrupting someone with" are different bars, and conflating
 *  them is how a discovery feed fills with marginal cards. */
export const STRONG_SCORE = 60;

/** Scope of a ranked read. `'all'` mixes equities and funds and must be asked
 *  for explicitly — see `resolveUniverseScope`. */
export type UniverseScope = CardUniverse | "all";

/**
 * Which universe a ranked read should cover.
 *
 * Defaults to `'stock'`, and that default is load-bearing rather than
 * cosmetic. A card score reads a price series directionally, and an inverse or
 * leveraged fund's series is the *negation* of the exposure its name implies —
 * SQQQ rising is the Nasdaq falling. Ranking those beside equities produced a
 * top-100 that was 71% ETFs and recommended a 2x inverse fund as a BUY next to
 * JNJ: a correct reading of the series and a meaningless recommendation.
 *
 * An unrecognized value collapses to the default instead of throwing. A
 * mistyped `?universe=stocks` should return equities, not a 500 — and must not
 * silently widen the scope to everything, which is the failure mode that
 * matters here.
 */
export function resolveUniverseScope(raw: unknown): UniverseScope {
  return raw === "etf" || raw === "stock" || raw === "all" ? raw : "stock";
}

/** Horizon for a ranked read; anything unrecognized is the short horizon. */
export function resolveHorizon(raw: unknown): Horizon {
  return raw === "t2" ? "t2" : "t1";
}

/**
 * Clamp a caller-supplied limit into `[1, MAX_TOP_LIMIT]`.
 *
 * Absent, unparseable, and out-of-range all resolve to something usable rather
 * than erroring: this is a read endpoint, and a bad `?limit=` is far more
 * likely to be a typo than an attack worth a 400.
 */
export function resolveLimit(raw: unknown, fallback: number = DEFAULT_TOP_LIMIT): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.trunc(n), MAX_TOP_LIMIT);
}

/** Is this card strong enough to surface without the user asking for it? */
export function isStrongCard(score: number, action: CardAction): boolean {
  return score >= STRONG_SCORE || action === "BUY" || action === "SELL";
}

/**
 * How stale is a card, in whole days, relative to `now`?
 *
 * Computed from `bar_date` (the session the card describes) rather than
 * `computed_at` (when the row was written), because a re-run that recomputes
 * yesterday's bars produces a fresh `computed_at` for stale data. The number a
 * reader cares about is how old the *market data* is.
 */
export function cardAgeDays(barDate: string | Date, now: Date = new Date()): number | null {
  const d = barDate instanceof Date ? barDate : new Date(`${barDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Summary counts for a ranked page — what a UI needs to describe the list
 * without walking it, and what makes a wrong ranking visible at a glance.
 *
 * `etfCount` is here specifically so an ETF-polluted ranking is legible in the
 * response body rather than only by inspecting every row. If a caller asks for
 * `'stock'` and sees a non-zero `etfCount`, the label drift that PR #70 fixed
 * has regressed.
 */
export function summarizeRanking(
  cards: readonly { score: number; action: CardAction; universe: CardUniverse }[],
): { total: number; strong: number; etfCount: number; topScore: number | null } {
  let strong = 0;
  let etfCount = 0;
  let topScore: number | null = null;
  for (const c of cards) {
    if (isStrongCard(c.score, c.action)) strong++;
    if (c.universe === "etf") etfCount++;
    if (topScore === null || c.score > topScore) topScore = c.score;
  }
  return { total: cards.length, strong, etfCount, topScore };
}
