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
import { gradeFromScore, PORTFOLIO_DISCLAIMER } from "../portfolio";
import type {
  HealthFactor,
  OptimizerSuggestion,
  PortfolioHealth,
} from "../portfolio";
import type { CardAction, CardUniverse } from "./card-policy";

/** Bump when the weights or factor set below change, so a cached score from an
 *  older shape is never presented beside a new one as though comparable. */
export const LOCAL_HEALTH_VERSION = "LOCAL_HEALTH_V1";

/** One `ticker_cards` row, reduced to the columns this scorer reads. */
export interface HealthCardInput {
  ticker: string;
  universe: CardUniverse;
  /** Deterministic card score in [-100, 100]; positive is bullish. */
  score: number;
  action: CardAction;
  /** 0..1 — `card-policy.dataQuality()` for the card. */
  dataQuality: number;
}

/** Watchlist size at which the diversification factor stops improving. Ten
 *  distinct names is the conventional floor for idiosyncratic-risk washout;
 *  beyond it, adding names is not what is limiting the portfolio. */
const DIVERSIFICATION_TARGET = 10;

/** Weights of the three *scored* factors. Coverage is deliberately excluded —
 *  see `buildCoverageFactor`. They sum to 1. */
const WEIGHTS = { signal: 0.45, direction: 0.3, diversification: 0.25 } as const;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
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
 * `dataQuality`.
 *
 * Weighting rather than filtering is the point: a card built from a gappy or
 * truncated series still carries information, it just should not outvote a
 * clean one. Dropping it instead would silently shrink the portfolio being
 * scored, which is the class of quiet substitution this whole file exists to
 * avoid.
 */
function buildSignalFactor(cards: HealthCardInput[]): HealthFactor {
  const weight = cards.reduce((sum, c) => sum + Math.max(c.dataQuality, 0.01), 0);
  const weighted = cards.reduce(
    (sum, c) => sum + toHealthScale(c.score) * Math.max(c.dataQuality, 0.01),
    0,
  );
  const score = Math.round(weighted / weight);
  return {
    name: "Signal strength",
    score,
    impact: impactFor(score),
    description:
      `Quality-weighted mean signal across ${cards.length} covered ` +
      `${cards.length === 1 ? "holding" : "holdings"}.`,
  };
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
  barDate: string | null,
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
  if (barDate) parts.push(`Latest bar ${barDate}.`);
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
 * @param cards            the subset that had a `ticker_cards` row.
 * @param barDate          `YYYY-MM-DD` of the newest bar behind those cards.
 */
export function buildLocalHealth(
  requestedTickers: string[],
  cards: HealthCardInput[],
  barDate: string | null = null,
  now: Date = new Date(),
): PortfolioHealth | null {
  if (requestedTickers.length === 0 || cards.length === 0) return null;

  const signal = buildSignalFactor(cards);
  const direction = buildDirectionFactor(cards);
  const diversification = buildDiversificationFactor(cards);
  const coverage = buildCoverageFactor(cards.length, requestedTickers.length);

  const score = Math.round(
    signal.score * WEIGHTS.signal +
      direction.score * WEIGHTS.direction +
      diversification.score * WEIGHTS.diversification,
  );

  return {
    score,
    grade: gradeFromScore(score),
    factors: [signal, direction, diversification, coverage],
    summary: summarize(score, cards, cards.length, requestedTickers.length, barDate),
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
