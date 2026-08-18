/**
 * card-policy — pure, dependency-free scoring and quality logic for
 * `ticker_cards`, the full-universe signal layer.
 *
 * The thesis (docs/max-coverage-simplest-path.md): coverage is expensive only
 * because the unit of coverage is an AI narrative. A *token card* — the
 * discretized tuple `lib/grounding/taxonomy.ts` already produces — costs no
 * quota, so every ticker can be covered while the model is spent only on the
 * top of the ranking.
 *
 * Split from card-db.ts for the same reason signal-policy.ts is split from
 * signal-lookup.ts: that module imports `@/lib/db`, which throws at import time
 * when DATABASE_URL is unset. Nothing here does I/O.
 */
import {
  TAXONOMY_VERSION,
  toStateKey,
  toStateKeyParts,
  type Horizon,
  type SignalStateInput,
  type StateKeyParts,
} from "@/lib/grounding/taxonomy";

/** Bump when the scorer's weights or action boundaries change, so two
 *  incompatible scores can never compete in one ranking unnoticed. */
export const CARD_SCORE_VERSION = "CARD_SCORE_V1";

/** Which engine produced a card. The two universes must never overlap: gcp3
 *  owns ETF rows, the hydration lane owns stock rows. Recorded per row so a
 *  bad vendor batch is traceable and selectively replaceable. */
export type CardUniverse = "etf" | "stock";

/** The five inputs `SignalStateInput` discretizes. Any missing one is allowed,
 *  but it must be *counted* — `toStateKeyParts()` defaults absent values into
 *  neutral-looking buckets, so without this list "neutral because the market is
 *  quiet" and "neutral because the fetch failed" become the same card. */
export const CARD_INPUT_FIELDS = [
  "rsi",
  "macdCross",
  "adx",
  "volatilityPercentile",
  "confluenceScore",
] as const;
export type CardInputField = (typeof CARD_INPUT_FIELDS)[number];

/** Cards at or above this quality may enter the ranked top-N explain batch. */
export const MIN_EXPLAIN_QUALITY = 0.8;

export type CardAction = "BUY" | "HOLD" | "SELL";

export interface TickerCard {
  ticker: string;
  universe: CardUniverse;
  stateKey: string;
  taxonomyVersion: string;
  tokens: StateKeyParts;
  score: number;
  scoreVersion: string;
  action: CardAction;
  dataQuality: number;
  missingFields: CardInputField[];
  horizon: Horizon;
}

/**
 * Which of the five discretized inputs were absent. Ordered by
 * CARD_INPUT_FIELDS so the stored array is stable across runs and two
 * equivalent cards compare equal.
 *
 * `macdCross` needs its own case, and the reason is worth stating: for the four
 * numeric fields `null` unambiguously means "not measured", but MACD has a
 * legitimate third state — *no cross occurred* — which is a real observation,
 * not a gap. A hydration job that computed MACD and found no crossover must be
 * able to say so, or every quiet tape would be scored as un-explainable. It
 * reports that as the literal `"none"`; `null` stays reserved for "not computed".
 */
export function missingInputFields(input: SignalStateInput): CardInputField[] {
  return CARD_INPUT_FIELDS.filter((field) =>
    field === "macdCross" ? input.macdCross === undefined : input[field] == null,
  );
}

/**
 * Fraction of the five inputs actually present, 0..1.
 *
 * Deliberately linear rather than weighted: any weighting here would encode a
 * second, hidden opinion about which indicator matters most, and that opinion
 * already lives in `scoreCard()` where it can be tested directly.
 */
export function dataQuality(input: SignalStateInput): number {
  const missing = missingInputFields(input).length;
  return (CARD_INPUT_FIELDS.length - missing) / CARD_INPUT_FIELDS.length;
}

/**
 * Deterministic score in [-100, 100] from the *tokens*, not the raw floats.
 *
 * Scoring the tokens rather than the numbers is the point: it makes the score
 * reproducible from a stored card with no vendor round-trip, and it means a
 * float that drifts inside its bucket cannot move the ranking. Positive is
 * bullish. The weights are the rules-based scorer that gcp3's `_score_etf`
 * proves works — promoted here from fallback to primary.
 */
export function scoreCard(parts: StateKeyParts): number {
  let score = 0;

  // Directional core: confluence is the strongest single signal, and its sign
  // comes from `direction` so a strong bearish setup scores as negative rather
  // than as a large positive with a contradicting label.
  const sign = parts.direction === "bearish" ? -1 : parts.direction === "bullish" ? 1 : 0;
  const confluenceWeight = { weak: 10, moderate: 30, strong: 50 }[parts.confluence];
  score += sign * confluenceWeight;

  // MACD cross is a discrete event and carries its own sign independent of the
  // verdict direction — a bullish cross under a bearish verdict is genuine
  // disagreement, and the score should reflect the tension rather than hide it.
  if (parts.macd === "bullish_cross") score += 20;
  else if (parts.macd === "bearish_cross") score -= 20;

  // RSI is mean-reverting: oversold is an opportunity, overbought a caution.
  if (parts.rsi === "oversold") score += 15;
  else if (parts.rsi === "overbought") score -= 15;

  // A trending market amplifies whatever direction is already established;
  // it is a multiplier on conviction, not a direction of its own.
  if (parts.adx === "trending") score *= 1.2;

  // High volatility widens the outcome distribution both ways, so it damps
  // conviction rather than pushing a direction.
  if (parts.vol === "high") score *= 0.85;

  return clamp(Math.round(score), -100, 100);
}

/**
 * BUY / HOLD / SELL from the score, with a wide neutral band.
 *
 * The band is wide on purpose. A card is a coverage artifact, not advice, and
 * the cost of a spurious BUY on one of 4,300 tickers is much higher than the
 * cost of an extra HOLD.
 */
export function actionFromScore(score: number): CardAction {
  if (score >= 35) return "BUY";
  if (score <= -35) return "SELL";
  return "HOLD";
}

/**
 * Build one complete card. Total — every ticker gets a card, including one
 * with no inputs at all, which lands as a HOLD at `dataQuality: 0` and is
 * excluded from ranking by `isExplainable()` rather than by being dropped.
 * Storing the honest empty card beats storing nothing: it records that the
 * ticker was seen and that its inputs were missing.
 */
export function buildCard(
  ticker: string,
  universe: CardUniverse,
  input: SignalStateInput,
  horizon: Horizon,
): TickerCard {
  const tokens = toStateKeyParts(input, horizon);
  const score = scoreCard(tokens);
  return {
    ticker,
    universe,
    stateKey: toStateKey(input, horizon),
    taxonomyVersion: TAXONOMY_VERSION,
    tokens,
    score,
    scoreVersion: CARD_SCORE_VERSION,
    action: actionFromScore(score),
    dataQuality: dataQuality(input),
    missingFields: missingInputFields(input),
    horizon,
  };
}

/**
 * May this card enter the quota-spending explain batch?
 *
 * Two independent gates: enough inputs were present, and none are missing.
 * Both are checked because they answer different questions — the ratio bounds
 * how much is known, the emptiness check refuses to let a *specific* absent
 * indicator be silently neutralized into a confident-looking narrative.
 */
export function isExplainable(card: TickerCard, minQuality: number = MIN_EXPLAIN_QUALITY): boolean {
  return card.dataQuality >= minQuality && card.missingFields.length === 0;
}

/**
 * Should an incoming card replace the stored one?
 *
 * The rule that keeps a bad vendor night from erasing a good one: never
 * overwrite real data with worse data for the same bar. A newer bar always
 * wins; the same bar wins only on strictly better quality; an older bar never
 * wins. This is why a failed symbol degrades to "yesterday's card" rather than
 * to nothing.
 */
export function shouldReplaceCard(
  incoming: { barDate: string; dataQuality: number },
  stored: { barDate: string; dataQuality: number } | null,
): boolean {
  if (!stored) return true;
  if (incoming.barDate > stored.barDate) return true;
  if (incoming.barDate < stored.barDate) return false;
  return incoming.dataQuality > stored.dataQuality;
}

/**
 * Model calls a top-N explain batch will cost. The ceiling must be knowable
 * *before* the job runs — a precompute that discovers its own cost by spending
 * it is the failure this whole design exists to prevent.
 */
export function explainCallCount(cardCount: number, batchSize: number): number {
  if (cardCount <= 0 || batchSize <= 0) return 0;
  return Math.ceil(cardCount / batchSize);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
