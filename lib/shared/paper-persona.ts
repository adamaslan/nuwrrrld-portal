/**
 * paper-persona — per-seat tie-break rules among equal-score card candidates
 * (docs/paper-trading-v3.md §3, F3/F5.3.6).
 *
 * F3 found that raising thresholds alone (§5.3) does not diverge the six
 * bots' picks: on a real day the card distribution clusters into ~12 distinct
 * values, so several tickers land on the same score constantly, and
 * `planRun`'s old alphabetical tie-break meant every bot bought the same
 * A-through-D name every day — a spelling accident wearing a "policy"
 * costume. This module gives each seat a rule that actually reads its
 * mandate (§3's persona table) instead of the alphabet, so ties resolve
 * differently per bot and the six books can start to genuinely diverge.
 *
 * Pure and DB-free, same rationale as paper-policy.ts: unit-testable without
 * pulling in ticker_cards or the planner's I/O shell. Each comparator reads
 * only `EngineCandidate.tokens`/`dataQuality` — fields the caller
 * (lib/paper-engine.ts) must populate from the card row before calling
 * `planRun`; a comparator that finds them missing returns 0 (no opinion),
 * deferring to the deterministic hash fallback `planRun` always applies last.
 */
import type { EngineCandidate } from "./paper-engine-core";
import { sectorFor, type PaperSector } from "./paper-sectors";
import type { TradingAccount } from "./paper-policy";

type Comparator = (a: EngineCandidate, b: EngineCandidate) => number;

function tok(c: EngineCandidate, key: string): string | undefined {
  return c.tokens?.[key];
}

/** Rank a categorical field by an explicit best-to-worst order; ties or
 *  missing values return 0. Shared by several comparators below so each
 *  persona rule reads as a short list, not a chain of if/else. */
function rankBy(order: string[]): (value: string | undefined) => number {
  return (value) => {
    if (value == null) return order.length; // worst — unknown beats nothing
    const idx = order.indexOf(value);
    return idx === -1 ? order.length : idx;
  };
}

const VOL_HIGH_FIRST = rankBy(["high", "normal", "low"]);
const VOL_LOW_FIRST = rankBy(["low", "normal", "high"]);

/** T1 — "the fresh event first" (§3): a live MACD cross outranks an RSI
 *  extreme, and higher volatility is what a 1-60 day tactical bot wants (it
 *  needs movement); a quiet, low-vol name is exactly what T2 should take
 *  instead. */
function t1TieBreak(a: EngineCandidate, b: EngineCandidate): number {
  const macdRank = (c: EngineCandidate) => (tok(c, "macd") === "bullish_cross" || tok(c, "macd") === "bearish_cross" ? 0 : 1);
  const byMacd = macdRank(a) - macdRank(b);
  if (byMacd !== 0) return byMacd;
  const rsiRank = (c: EngineCandidate) => (tok(c, "rsi") === "oversold" || tok(c, "rsi") === "overbought" ? 0 : 1);
  const byRsi = rsiRank(a) - rsiRank(b);
  if (byRsi !== 0) return byRsi;
  return VOL_HIGH_FIRST(tok(a, "vol")) - VOL_HIGH_FIRST(tok(b, "vol"));
}

/** T2 — the opposite instinct from T1 (§3): quiet, trending names over
 *  volatile events. A compounder wants a name settling into a multi-year
 *  trend, not the one T1 already wants. */
function t2TieBreak(a: EngineCandidate, b: EngineCandidate): number {
  const byVol = VOL_LOW_FIRST(tok(a, "vol")) - VOL_LOW_FIRST(tok(b, "vol"));
  if (byVol !== 0) return byVol;
  const adxRank = (c: EngineCandidate) => (tok(c, "adx") === "trending" ? 0 : 1);
  return adxRank(a) - adxRank(b);
}

/** RISK — survive-being-wrong (§3): lowest volatility first, among an
 *  already-tight buy threshold. Sector headroom is enforced by CLIP itself
 *  (a full sector clips regardless of order); this only orders *which*
 *  tied candidate is tried first when two compete for the same shrinking
 *  turnover/cash budget. */
function riskTieBreak(a: EngineCandidate, b: EngineCandidate): number {
  return VOL_LOW_FIRST(tok(a, "vol")) - VOL_LOW_FIRST(tok(b, "vol"));
}

/**
 * MACRO — sector rotation, expressed through breadth (§3: "Utilities breadth
 * is 7 of 9 bullish, the widest of any sector"). Computed once per call from
 * the *entire* candidate set the account is screening this run (not just the
 * tied pair), so the comparator can actually answer "which sector has the
 * most agreement" rather than just comparing two tickers' own tokens.
 * ETFs get a fixed preference within equal breadth, since sector rotation is
 * macro's whole thesis and a single stock is a weaker expression of it.
 */
function buildMacroTieBreak(allCandidates: readonly EngineCandidate[]): Comparator {
  const bullishCount = new Map<PaperSector, number>();
  const totalCount = new Map<PaperSector, number>();
  for (const c of allCandidates) {
    const sector = sectorFor(c.ticker);
    if (!sector) continue;
    totalCount.set(sector, (totalCount.get(sector) ?? 0) + 1);
    if (tok(c, "direction") === "bullish") bullishCount.set(sector, (bullishCount.get(sector) ?? 0) + 1);
  }
  function breadth(ticker: string): number {
    const sector = sectorFor(ticker);
    if (!sector) return 0;
    const total = totalCount.get(sector) ?? 0;
    return total > 0 ? (bullishCount.get(sector) ?? 0) / total : 0;
  }
  return (a, b) => {
    const byBreadth = breadth(b.ticker) - breadth(a.ticker); // higher breadth first
    if (Math.abs(byBreadth) > 1e-9) return byBreadth;
    const isEtf = (c: EngineCandidate) => (sectorFor(c.ticker) === "ETF" ? 0 : 1);
    return isEtf(a) - isEtf(b);
  };
}

/** QUANT — numbers only, by construction (§3): the highest data_quality wins
 *  a tie, since QUANT's whole mandate is trusting the numbers more than any
 *  other seat, and a higher-coverage card is a more-trustworthy number. */
function quantTieBreak(a: EngineCandidate, b: EngineCandidate): number {
  return (b.dataQuality ?? 0) - (a.dataQuality ?? 0);
}

/** CHAIR has no score-based tie-break: it runs `planChairConsensus` instead
 *  of `planRun` entirely (docs/paper-trading-v3.md §3), so it never calls
 *  into this module. Listed here only so `buildTieBreak`'s switch is total. */

/**
 * Build the tie-break comparator for one trading account, given the full
 * candidate set it's screening this run (only MACRO's needs the full set;
 * everyone else's rule is pairwise). Returns `undefined` for `chair`, which
 * plans consensus, not a ranked buy list, and never reaches `planRun`.
 */
export function buildTieBreak(
  account: TradingAccount,
  allCandidates: readonly EngineCandidate[],
): Comparator | undefined {
  switch (account) {
    case "t1":
      return t1TieBreak;
    case "t2":
      return t2TieBreak;
    case "risk":
      return riskTieBreak;
    case "macro":
      return buildMacroTieBreak(allCandidates);
    case "quant":
      return quantTieBreak;
    case "chair":
      return undefined;
  }
}
