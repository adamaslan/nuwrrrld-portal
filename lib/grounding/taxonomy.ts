/**
 * Signal-state taxonomy — the finite, enumerable key space the compiled
 * grounding pack is indexed on (see docs/ai-council-timeline.html, PR 1).
 *
 * `toStateKeys()` is a pure function: same signal input + horizon always
 * produces the same key, so the pack lookup (Tier 0) is a plain indexed
 * join, not a search. Bump TAXONOMY_VERSION whenever a dimension's bucket
 * boundaries change — like CHROMA_COLLECTION_VERSION for chunk hashes, a
 * version change invalidates every existing pack row's state_key.
 */

export const TAXONOMY_VERSION = "TAXONOMY_V1";

export type RsiRegime = "oversold" | "neutral" | "overbought";
export type MacdCrossState = "bullish_cross" | "bearish_cross" | "none";
export type AdxTrendBucket = "trending" | "ranging";
export type VolatilityRegime = "low" | "normal" | "high";
export type ConfluenceBucket = "weak" | "moderate" | "strong";
export type VerdictDirection = "bullish" | "bearish" | "neutral";
export type Horizon = "t1" | "t2";

/** Raw signal fields as available from gcp3 `/signals` or a holdfold verdict. */
export interface SignalStateInput {
  rsi?: number | null;
  macdCross?: "bullish" | "bearish" | null;
  adx?: number | null;
  volatilityPercentile?: number | null; // 0-100, e.g. ATR or VIX percentile rank
  confluenceScore?: number | null; // 0-100
  direction?: VerdictDirection | null;
}

export interface StateKeyParts {
  rsi: RsiRegime;
  macd: MacdCrossState;
  adx: AdxTrendBucket;
  vol: VolatilityRegime;
  confluence: ConfluenceBucket;
  direction: VerdictDirection;
  horizon: Horizon;
}

const RSI_OVERSOLD_MAX = 30;
const RSI_OVERBOUGHT_MIN = 70;
const ADX_TRENDING_MIN = 25;
const VOL_LOW_MAX = 33;
const VOL_HIGH_MIN = 67;
const CONFLUENCE_MODERATE_MIN = 34;
const CONFLUENCE_STRONG_MIN = 67;

function bucketRsi(rsi: number | null | undefined): RsiRegime {
  if (rsi == null) return "neutral";
  if (rsi <= RSI_OVERSOLD_MAX) return "oversold";
  if (rsi >= RSI_OVERBOUGHT_MIN) return "overbought";
  return "neutral";
}

function bucketMacd(cross: "bullish" | "bearish" | null | undefined): MacdCrossState {
  if (cross === "bullish") return "bullish_cross";
  if (cross === "bearish") return "bearish_cross";
  return "none";
}

function bucketAdx(adx: number | null | undefined): AdxTrendBucket {
  return adx != null && adx >= ADX_TRENDING_MIN ? "trending" : "ranging";
}

function bucketVol(percentile: number | null | undefined): VolatilityRegime {
  if (percentile == null) return "normal";
  if (percentile <= VOL_LOW_MAX) return "low";
  if (percentile >= VOL_HIGH_MIN) return "high";
  return "normal";
}

function bucketConfluence(score: number | null | undefined): ConfluenceBucket {
  const abs = score == null ? 0 : Math.abs(score);
  if (abs >= CONFLUENCE_STRONG_MIN) return "strong";
  if (abs >= CONFLUENCE_MODERATE_MIN) return "moderate";
  return "weak";
}

/** Bucket the raw signal fields into the taxonomy's finite dimensions. */
export function toStateKeyParts(input: SignalStateInput, horizon: Horizon): StateKeyParts {
  return {
    rsi: bucketRsi(input.rsi),
    macd: bucketMacd(input.macdCross),
    adx: bucketAdx(input.adx),
    vol: bucketVol(input.volatilityPercentile),
    confluence: bucketConfluence(input.confluenceScore),
    direction: input.direction ?? "neutral",
    horizon,
  };
}

function partsToKey(parts: StateKeyParts): string {
  return `rsi:${parts.rsi}|macd:${parts.macd}|adx:${parts.adx}|vol:${parts.vol}|confluence:${parts.confluence}|dir:${parts.direction}|h:${parts.horizon}`;
}

/**
 * Map a live signal payload + horizon to its canonical state key, e.g.
 * `rsi:oversold|macd:bullish_cross|adx:trending|vol:normal|confluence:strong|dir:bullish|h:t1`.
 * This is the exact key `grounding_pack.state_key` is compiled against and
 * `lib/grounding/resolve.ts` (PR 3) will join on.
 */
export function toStateKey(input: SignalStateInput, horizon: Horizon): string {
  return partsToKey(toStateKeyParts(input, horizon));
}
