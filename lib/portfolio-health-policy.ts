/**
 * portfolio-health-policy — pure, dependency-free computation of a
 * `PortfolioHealth` (and optimizer suggestions) from `ticker_cards` rows.
 *
 * Why this exists: `{MCP_BACKEND_URL}/api/portfolio/health` has never been
 * deployed. The gcp3 backend's live OpenAPI registers no portfolio route at
 * all, so the portal's upstream call 404s and the panel renders "Health score
 * unavailable" forever — see
 * docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md.
 * That incident's own conclusion is the design brief for this file:
 *
 *   "Degradation chains need a terminal honest state, not a chain of optional
 *    dependencies that can all be absent at once."
 *
 * `ticker_cards` is that terminal state. It is portal-owned, covers the whole
 * registered universe, and is already the deterministic scorer behind the
 * signals surface — so a watchlist can be scored with no network call to
 * anyone. Upstream stays the preferred source when it answers; this is what
 * runs when it does not.
 *
 * Split from the DB reader (`lib/portfolio-health-local.ts`) for the same
 * reason `card-policy.ts` is split from `ticker-cards-db.ts`: `@/lib/db`
 * throws at import time without DATABASE_URL, and nothing here does I/O.
 */
import { gradeFromScore, PORTFOLIO_DISCLAIMER } from "./portfolio";
import type {
  HealthFactor,
  OptimizerSuggestion,
  PortfolioHealth,
} from "./portfolio";
import type { CardAction, CardUniverse } from "./shared/card-policy";
import { cardAgeDays } from "./shared/universe-policy";

/** Bump when the weights or factor set below change, so a cached score from an
 *  older shape is never presented beside a new one as though comparable. */
export const LOCAL_HEALTH_VERSION = "LOCAL_HEALTH_V2";

/** One `ticker_cards` row, reduced to the columns this scorer reads. */
export interface HealthCardInput {
  ticker: string;
  universe: CardUniverse;
  /** Deterministic card score in [-100, 100]; positive is bullish. */
  score: number;
  action: CardAction;
  /** 0..1 — `card-policy.dataQuality()` for the card. */
  dataQuality: number;
  /**
   * `YYYY-MM-DD` of the bar this card describes. Optional only so existing
   * fixtures that predate this field keep compiling — a caller that omits it
   * gets no freshness penalty and no freshness credit for that card, which is
   * strictly more honest than guessing.
   *
   * This is deliberately separate from `dataQuality`: that field is measured
   * once, at hydration time, and frozen in the row. A card built from a clean
   * window scores `dataQuality: 1.0` forever, even after the bar behind it is
   * a month stale — see docs/portfolio-health-todo.md §0. Freshness has to be
   * re-derived against `now` on every read; it cannot live in a stored column.
   */
  barDate?: string;
}

/** Watchlist size at which the diversification factor stops improving. Ten
 *  distinct names is the conventional floor for idiosyncratic-risk washout;
 *  beyond it, adding names is not what is limiting the portfolio. */
const DIVERSIFICATION_TARGET = 10;

/** Weights of the four *scored* factors. Coverage is deliberately excluded —
 *  see `buildCoverageFactor`. They sum to 1. Freshness (0.20) was carved out of
 *  the original three (0.45/0.30/0.25, scaled by 0.8) rather than picked fresh,
 *  so the relative balance between signal/direction/diversification is
 *  unchanged from before §0's fix. */
const WEIGHTS = { signal: 0.36, direction: 0.24, diversification: 0.2, freshness: 0.2 } as const;

/** A card at or below this many days old carries no freshness penalty at all —
 *  the normal gap between a bar closing and a read the same or next day. */
const FRESHNESS_FULL_WEIGHT_DAYS = 2;
/** Beyond this many days stale, a card is floored at `FRESHNESS_MIN_FACTOR`
 *  rather than driven to zero. ~4 trading weeks: long enough that "one bad
 *  week" doesn't floor a card, short enough that the 26-day-stale cards
 *  observed in docs/portfolio-health-todo.md §0 land at the floor, not
 *  somewhere in the middle pretending to still be informative. */
const FRESHNESS_STALE_FLOOR_DAYS = 20;
/** A fully stale card still counts — never dropped, per §0's explicit
 *  "do not fix this by hiding stale cards" — but contributes almost nothing to
 *  the weighted average once past the floor. */
const FRESHNESS_MIN_FACTOR = 0.05;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 1.0 at or below `FRESHNESS_FULL_WEIGHT_DAYS`, linear down to
 * `FRESHNESS_MIN_FACTOR` at `FRESHNESS_STALE_FLOOR_DAYS`, floored there.
 */
function freshnessFactor(ageDays: number): number {
  if (ageDays <= FRESHNESS_FULL_WEIGHT_DAYS) return 1;
  const span = FRESHNESS_STALE_FLOOR_DAYS - FRESHNESS_FULL_WEIGHT_DAYS;
  const factor = 1 - (ageDays - FRESHNESS_FULL_WEIGHT_DAYS) / span;
  return clamp(factor, FRESHNESS_MIN_FACTOR, 1);
}

/** Card score [-100, 100] → health scale [0, 100]. */
function toHealthScale(cardScore: number): number {
  return clamp((cardScore + 100) / 2, 0, 100);
}

function impactFor(score: number): HealthFactor["impact"] {
  if (score >= 60) return "positive";
  if (score < 45) return "negative";
  return "neutral";
}

/**
 * Mean card score across the covered watchlist, weighted by each card's
 * `dataQuality` **and** how stale its bar is as of `now`.
 *
 * Weighting rather than filtering is the point: a card built from a gappy or
 * truncated series still carries information, it just should not outvote a
 * clean one. Dropping it instead would silently shrink the portfolio being
 * scored, which is the class of quiet substitution this whole file exists to
 * avoid.
 *
 * `dataQuality` alone is not enough — it is frozen at hydration time, so a
 * card that was clean when built and then sat unrefreshed for a month still
 * reports `1.0` (docs/portfolio-health-todo.md §0). Multiplying in
 * `freshnessFactor(ageDays)`, computed against `now` rather than read from a
 * stored column, is what actually discounts a card that has gone stale since
 * arrival — the gap the incident measured.
 */
function buildSignalFactor(cards: HealthCardInput[], now: Date): HealthFactor {
  const cardWeight = (c: HealthCardInput) => {
    const fresh = c.barDate ? freshnessFactor(cardAgeDays(c.barDate, now) ?? 0) : 1;
    return Math.max(c.dataQuality, 0.01) * fresh;
  };
  const weight = cards.reduce((sum, c) => sum + cardWeight(c), 0);
  const weighted = cards.reduce((sum, c) => sum + toHealthScale(c.score) * cardWeight(c), 0);
  const score = Math.round(weighted / weight);
  return {
    name: "Signal strength",
    score,
    impact: impactFor(score),
    description:
      `Quality- and freshness-weighted mean signal across ${cards.length} covered ` +
      `${cards.length === 1 ? "holding" : "holdings"}.`,
  };
}

/**
 * How stale the covered cards are, scored (not just informational) — unlike
 * coverage, "the data we have is a month old" is a genuinely worse basis for a
 * grade, and treating it as neutral information would repeat the conflation
 * §0 identified between "no data" and "bad data." Month-old signals are
 * different from no signals: they are actively worse to rely on than an
 * honest gap.
 */
function buildFreshnessFactor(cards: HealthCardInput[], now: Date): HealthFactor {
  const dated = cards
    .map((c) => (c.barDate ? cardAgeDays(c.barDate, now) : null))
    .filter((d): d is number => d !== null);

  if (dated.length === 0) {
    return {
      name: "Signal freshness",
      score: 100,
      impact: "neutral",
      description: "Bar dates unavailable for this read — freshness could not be assessed.",
    };
  }

  const meanFactor = dated.reduce((sum, d) => sum + freshnessFactor(d), 0) / dated.length;
  const score = Math.round(meanFactor * 100);
  const staleCount = dated.filter((d) => d > FRESHNESS_FULL_WEIGHT_DAYS).length;
  const oldest = Math.max(...dated);

  return {
    name: "Signal freshness",
    score,
    impact: impactFor(score),
    description:
      staleCount === 0
        ? `All ${dated.length} dated holdings carry a signal ${FRESHNESS_FULL_WEIGHT_DAYS} day(s) old or newer.`
        : `${staleCount} of ${dated.length} dated holdings carry a signal older than ` +
          `${FRESHNESS_FULL_WEIGHT_DAYS} days; oldest is ${oldest} day${oldest === 1 ? "" : "s"} stale.`,
  };
}

/**
 * `"50 from 2026-09-13, 882 from 2026-08-19"` — the distribution of bar dates
 * behind the covered cards, largest group first.
 *
 * Replaces reporting `max(bar_date)` as *the* portfolio's bar date, which read
 * as "this is current" when one fresh card could hide hundreds of month-old
 * ones (§0's central finding). A single date cannot describe this set
 * honestly; a short distribution can.
 */
function summarizeBarDates(cards: HealthCardInput[]): string | null {
  const dated = cards.filter((c): c is HealthCardInput & { barDate: string } => !!c.barDate);
  if (dated.length === 0) return null;

  const counts = new Map<string, number>();
  for (const c of dated) counts.set(c.barDate, (counts.get(c.barDate) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));

  const shown = sorted.slice(0, 3).map(([date, n]) => `${n} from ${date}`);
  const rest = sorted.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest} more date${rest === 1 ? "" : "s"}` : shown.join(", ");
}

/**
 * How much of the watchlist is flagged SELL versus BUY.
 *
 * Reported as its own factor rather than folded into signal strength because
 * the two answer different questions: a portfolio of uniformly mild positives
 * and one split between strong BUYs and strong SELLs can share a mean while
 * demanding completely different attention.
 */
function buildDirectionFactor(cards: HealthCardInput[]): HealthFactor {
  const sells = cards.filter((c) => c.action === "SELL").length;
  const buys = cards.filter((c) => c.action === "BUY").length;
  // 100 when nothing is flagged SELL, 0 when everything is. Buys lift the
  // floor so an all-BUY book does not read the same as an all-HOLD one.
  const sellShare = sells / cards.length;
  const buyShare = buys / cards.length;
  const score = Math.round(clamp(100 - sellShare * 100 + buyShare * 15, 0, 100));
  return {
    name: "Directional risk",
    score,
    impact: impactFor(score),
    description: `${buys} BUY · ${cards.length - buys - sells} HOLD · ${sells} SELL across covered holdings.`,
  };
}

/**
 * Breadth: distinct names, with a penalty for a book that is entirely one
 * asset class.
 *
 * This is a crude proxy and is labelled as one — `ticker_universe` records
 * only `etf`/`stock`, not sector, so genuine sector concentration is invisible
 * here. Overstating what the data supports is how the upstream adapter's
 * "score 0, Grade F for everyone" failure read as a real result.
 */
function buildDiversificationFactor(cards: HealthCardInput[]): HealthFactor {
  const breadth = clamp(cards.length / DIVERSIFICATION_TARGET, 0, 1) * 100;
  const etfs = cards.filter((c) => c.universe === "etf").length;
  const mixed = etfs > 0 && etfs < cards.length;
  const score = Math.round(clamp(mixed ? breadth : breadth * 0.85, 0, 100));
  return {
    name: "Diversification",
    score,
    impact: impactFor(score),
    description:
      `${cards.length} distinct ${cards.length === 1 ? "name" : "names"} ` +
      `(${etfs} ETF · ${cards.length - etfs} single-stock). ` +
      `Breadth only — sector concentration is not measured.`,
  };
}

/**
 * What fraction of the watchlist actually had a card to score.
 *
 * Informational, never scored. Folding coverage into the headline would make a
 * thinly-covered portfolio indistinguishable from a genuinely unhealthy one —
 * exactly the conflation between "no data" and "bad data" that the incident
 * turned on. It is surfaced so a user can see the score is partial instead of
 * being quietly handed a number computed from three of their twenty names.
 */
function buildCoverageFactor(covered: number, requested: number): HealthFactor {
  const score = Math.round((covered / requested) * 100);
  return {
    name: "Signal coverage",
    score,
    impact: "neutral",
    description:
      `${covered} of ${requested} watchlist ${requested === 1 ? "ticker" : "tickers"} ` +
      `had a computed signal. Informational — not part of the score.`,
  };
}

function summarize(
  score: number,
  cards: HealthCardInput[],
  covered: number,
  requested: number,
): string {
  const sells = cards.filter((c) => c.action === "SELL").length;
  const buys = cards.filter((c) => c.action === "BUY").length;
  const grade = gradeFromScore(score);
  const parts = [
    `Grade ${grade} (${score}/100) from the portal's own signal engine across ` +
      `${covered} of ${requested} watchlist ${requested === 1 ? "ticker" : "tickers"}.`,
    buys > 0 || sells > 0
      ? `${buys} flagged BUY, ${sells} flagged SELL.`
      : `Nothing is currently flagged BUY or SELL.`,
  ];
  if (covered < requested) {
    parts.push(
      `${requested - covered} ${requested - covered === 1 ? "ticker has" : "tickers have"} ` +
        `no computed signal yet and did not affect the score.`,
    );
  }
  // Distribution, not a single "latest bar" — see summarizeBarDates()'s header.
  const barDates = summarizeBarDates(cards);
  if (barDates) parts.push(`Bar dates: ${barDates}.`);
  return parts.join(" ");
}

/**
 * Build a `PortfolioHealth` from locally-computed cards.
 *
 * Returns `null` when not one requested ticker has a card — the honest
 * terminal state. A zero-coverage portfolio has no score, and inventing one
 * (the upstream path's `score ?? 0` behaviour) is worse than saying so.
 *
 * @param requestedTickers every ticker on the watchlist, including uncovered ones.
 * @param cards            the subset that had a `ticker_cards` row. Each
 *                          card's own `barDate` drives freshness — there is no
 *                          separate portfolio-wide bar-date parameter, because
 *                          §0 established that a single date cannot describe a
 *                          set whose cards can span weeks.
 * @param now               injectable for deterministic tests of freshness.
 */
export function buildLocalHealth(
  requestedTickers: string[],
  cards: HealthCardInput[],
  now: Date = new Date(),
): PortfolioHealth | null {
  if (requestedTickers.length === 0 || cards.length === 0) return null;

  const signal = buildSignalFactor(cards, now);
  const direction = buildDirectionFactor(cards);
  const diversification = buildDiversificationFactor(cards);
  const freshness = buildFreshnessFactor(cards, now);
  const coverage = buildCoverageFactor(cards.length, requestedTickers.length);

  const score = Math.round(
    signal.score * WEIGHTS.signal +
      direction.score * WEIGHTS.direction +
      diversification.score * WEIGHTS.diversification +
      freshness.score * WEIGHTS.freshness,
  );

  return {
    score,
    grade: gradeFromScore(score),
    factors: [signal, direction, diversification, freshness, coverage],
    summary: summarize(score, cards, cards.length, requestedTickers.length),
    generatedAt: now.toISOString(),
  };
}

/** Cards at or below this score are worth surfacing as a trim candidate. */
const SUGGEST_SELL_AT = -35;
/** Cards at or above this are worth surfacing as an add candidate. */
const SUGGEST_BUY_AT = 35;
/** Never return more than this many; the panel is a prompt, not a report. */
const MAX_SUGGESTIONS = 6;

/**
 * Optimizer suggestions from the same cards.
 *
 * Same rationale as the health score: `{MCP_BACKEND_URL}/api/portfolio/suggestions`
 * is likewise unimplemented upstream, and the route's `catch → []` renders as
 * "check back after adding tickers" no matter how many tickers are added —
 * indistinguishable from a genuinely quiet day.
 */
export function buildLocalSuggestions(
  cards: HealthCardInput[],
  watchlistSize: number,
): OptimizerSuggestion[] {
  const out: OptimizerSuggestion[] = [];

  const sells = cards
    .filter((c) => c.score <= SUGGEST_SELL_AT)
    .sort((a, b) => a.score - b.score);
  const buys = cards
    .filter((c) => c.score >= SUGGEST_BUY_AT)
    .sort((a, b) => b.score - a.score);

  for (const c of sells.slice(0, 3)) {
    out.push({
      id: `local-sell-${c.ticker}`,
      title: `Review ${c.ticker}`,
      rationale:
        `${c.ticker} scores ${c.score} on the portal signal engine — a SELL reading. ` +
        `Worth a look before it drifts further.`,
      ticker: c.ticker,
      priority: "high",
      disclaimer: PORTFOLIO_DISCLAIMER,
    });
  }

  for (const c of buys.slice(0, 3)) {
    out.push({
      id: `local-buy-${c.ticker}`,
      title: `${c.ticker} is strengthening`,
      rationale:
        `${c.ticker} scores ${c.score} — a BUY reading on the portal signal engine.`,
      ticker: c.ticker,
      priority: "medium",
      disclaimer: PORTFOLIO_DISCLAIMER,
    });
  }

  if (watchlistSize > 0 && watchlistSize < 5) {
    out.push({
      id: "local-breadth",
      title: "Add more names",
      rationale:
        `A ${watchlistSize}-ticker watchlist concentrates idiosyncratic risk. ` +
        `Ten or more distinct names is the usual floor for breadth.`,
      priority: "low",
      disclaimer: PORTFOLIO_DISCLAIMER,
    });
  }

  return out.slice(0, MAX_SUGGESTIONS);
}
