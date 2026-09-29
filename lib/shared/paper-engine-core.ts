/**
 * paper-engine-core — pure logic for the deterministic paper-portfolio run
 * loop (docs/council-paper-portfolios.md §4.2, steps RANK/PROPOSE/CLIP/FILL).
 *
 * No I/O here so the run-planning and fill-simulation logic is unit-testable
 * without Neon — same split as lib/shared/card-policy.ts vs lib/ticker-cards-db.ts.
 * `lib/paper-engine.ts` is the DB-touching orchestrator (LOAD/MARK/SCREEN/PERSIST)
 * that calls into this module for the parts that are pure functions of state.
 *
 * Step 6 (ARBITRATE, Phase 5) is implemented below as `selectArbitrationCandidates`
 * + `applyArbitrationResults`, but deliberately applied *after* this module's
 * combined PROPOSE+CLIP pass rather than between them as §4.2 numbers the
 * steps. A veto only removes an order and a downsize only shrinks its
 * quantity, so applying arbitration to an already-CLIP-satisfying order list
 * can never violate a cap that list already satisfied — re-running CLIP
 * against a smaller order set would only ever leave more headroom, never
 * less, so nothing downstream needs re-optimizing. Slotting arbitration
 * before CLIP instead would raise exactly that re-optimization question
 * (does freeing turnover budget let a *different*, non-arbitrated candidate
 * in?) that guardrail #5 ("the model never invents a ticker or a size") is
 * written to foreclose. Post-CLIP application keeps that guarantee by
 * construction instead of needing to prove it.
 *
 * Known simplification: a sell is always a full exit of the position, never a
 * partial trim. The design doc's exit reasons (stop / score_exit / void) are
 * all full-exit events by nature; nothing in §4 calls for partially trimming an
 * oversized *existing* position back to its cap, so that case is left for a
 * later phase rather than invented here.
 */
import type { PaperPolicy } from "./paper-policy";
import { isMegaOrLargeCap, sectorFor, type PaperSector } from "./paper-sectors";

export type OrderReason =
  | "score_entry"
  | "score_exit"
  | "stop"
  | "void"
  | "cap_clip"
  | "seat_downsize";

export interface EngineCandidate {
  ticker: string;
  /** ticker_cards.score for the account's card horizon, already resolved by
   *  the caller (t1/t2/both -> whichever score the SCREEN step selected). */
  score: number;
  /** The card's state-key tokens (rsi/macd/adx/vol/confluence/direction), when
   *  the caller has them — persona tie-breaks (docs/paper-trading-v3.md §3)
   *  read these to choose among equal-score candidates. Optional so existing
   *  callers/tests that only care about score keep working unchanged. */
  tokens?: Record<string, string>;
  /** ticker_cards.data_quality for whichever row the score came from — QUANT's
   *  tie-break reads this (§3: "tie-break on data_quality desc"). */
  dataQuality?: number;
}

export interface EnginePosition {
  ticker: string;
  quantity: number;
  avgCost: number;
  runsHeld: number;
  /** Already updated by the caller's MARK step to include this run's price,
   *  i.e. `Math.max(previousHighWater, currentPrice)`. */
  highWater: number;
}

export interface ProposedOrder {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  refPrice: number;
  reason: OrderReason;
}

export interface FilledOrder extends ProposedOrder {
  fillPrice: number;
  slippageBps: number;
  notional: number;
  /** Only set for sells — realized P&L against the position's avg cost. */
  realizedPnl: number | null;
}

export interface RunPlanInput {
  policy: PaperPolicy;
  /** Cash + mark-to-market value of all held positions, computed by the
   *  caller's MARK step before this run. The denominator every weight/cap in
   *  this module is expressed against. */
  nav: number;
  cash: number;
  positions: EnginePosition[];
  /** Already SCREENed: active watchlist, data-quality gate, fresh bar_date. */
  candidates: EngineCandidate[];
  /** Tickers still buyable — a held position outside this set is a forced
   *  exit (deactivated/delisted watchlist row), regardless of score. */
  activeWatchlist: ReadonlySet<string>;
  /** Reference price per ticker for this slot. A ticker with no entry here
   *  cannot be traded this run (no price to fill at). */
  prices: Readonly<Record<string, number>>;
  /** Persona tie-break (docs/paper-trading-v3.md §3): a comparator applied
   *  between candidates at an equal score, before the deterministic hash
   *  fallback. Return 0 to defer to the hash — a persona comparator only
   *  needs to say what it has an opinion about. Omitted entirely, buys sort
   *  on score then the hash alone. */
  tieBreak?: (a: EngineCandidate, b: EngineCandidate) => number;
  /** Seeds the hash tie-break so it changes by trade_date (deterministic per
   *  day, not fixed forever) — see `hashTicker`. Defaults to "" so existing
   *  callers/tests that don't care about tie-break stability keep working. */
  tieBreakSeed?: string;
}

export interface RunPlan {
  orders: ProposedOrder[];
  /** Fraction of NAV committed to orders this run — always <= policy.maxTurnoverPerRun. */
  turnoverUsed: number;
}

function isStopTriggered(policy: PaperPolicy, position: EnginePosition, price: number): boolean {
  const basis = policy.stopRule.kind === "fixed" ? position.avgCost : position.highWater;
  return price <= basis * (1 - policy.stopRule.pct);
}

/**
 * Deterministic 32-bit FNV-1a hash of `ticker:seed`, mapped to [0, 1). The
 * final tie-break (docs/paper-trading-v3.md §3, §5.1.6): every earlier tie
 * on this codebase's data clustered around a handful of card scores (12
 * distinct values across 978 tickers on 2026-09-29), and breaking those ties
 * alphabetically meant the same few names (those starting with A–D) won every
 * tie, every day — not a persona difference, a spelling accident. Seeding by
 * `tieBreakSeed` (the trade_date) means the winner changes day to day instead
 * of being fixed forever, without needing real randomness in something that
 * must replay identically for the same inputs.
 */
export function hashTicker(ticker: string, seed: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${ticker}:${seed}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

/**
 * RANK + PROPOSE + CLIP (§4.2 steps 4–7), as one pure pass over the account's
 * current state. Sells are evaluated first (they free cash, turnover, and
 * sector headroom for the buys that follow), then buys are ranked by score
 * descending (ticker ascending as the deterministic tie-break) and greedily
 * accepted subject to, in order: turnover cap, position cap, sector cap, cash
 * floor. A candidate that fails any check is clipped (skipped), never
 * partially filled past the check that stopped it short of its target size.
 */
export function planRun(input: RunPlanInput): RunPlan {
  const { policy, nav, candidates, activeWatchlist, prices, tieBreak, tieBreakSeed = "" } = input;
  if (nav <= 0) return { orders: [], turnoverUsed: 0 };

  const scoreByTicker = new Map(candidates.map((c) => [c.ticker, c.score]));
  const positionsByTicker = new Map(input.positions.map((p) => [p.ticker, { ...p }]));
  const turnoverCapNotional = policy.maxTurnoverPerRun * nav;
  const cashFloorAmount = policy.cashFloor * nav;
  // F13 (docs/paper-trading-v3.md): a ticker sold this run — for any reason —
  // is removed from `positionsByTicker` below, which makes the buys loop see
  // it as unheld (zero weight) and free to re-enter at full size. That
  // silently undoes a stop-loss in the same run it fired, at the cost of a
  // second lot of slippage. Tracking exits here and excluding them from the
  // buy candidates (see buyCandidates' filter) closes that loop: an exit ends
  // the position for the rest of this run, full stop.
  const soldThisRun = new Set<string>();

  const sectorWeight = new Map<PaperSector, number>();
  for (const p of input.positions) {
    const price = prices[p.ticker] ?? p.avgCost;
    const sector = sectorFor(p.ticker);
    if (sector) {
      sectorWeight.set(sector, (sectorWeight.get(sector) ?? 0) + (p.quantity * price) / nav);
    }
  }

  const orders: ProposedOrder[] = [];
  let turnoverUsed = 0;
  let cash = input.cash;

  function positionWeight(ticker: string): number {
    const p = positionsByTicker.get(ticker);
    if (!p) return 0;
    const price = prices[ticker] ?? p.avgCost;
    return (p.quantity * price) / nav;
  }

  // ── Sells ──────────────────────────────────────────────────────────────
  for (const p of [...positionsByTicker.values()]) {
    const price = prices[p.ticker];
    if (price == null) continue; // no reference price this slot — can't fill

    const forced = !activeWatchlist.has(p.ticker);
    const stopHit = isStopTriggered(policy, p, price);
    const score = scoreByTicker.get(p.ticker);
    const signalExit = score != null && score < policy.sellThreshold;
    const minHoldSatisfied = p.runsHeld >= policy.minHoldingPeriodRuns;

    // A stop or a forced (deactivated/delisted) exit overrides the minimum
    // holding period, per §4.2's own note; a signal-only exit does not.
    let reason: OrderReason | null = null;
    if (forced) reason = "void";
    else if (stopHit) reason = "stop";
    else if (minHoldSatisfied && signalExit) reason = "score_exit";
    if (!reason) continue;

    const notional = p.quantity * price;
    // F5 (docs/paper-trading-v3.md): the turnover cap gates a *discretionary*
    // exit (score_exit) — an account is allowed to decide "not this run,
    // budget's spent" about a signal-driven sell. It must never gate a stop
    // or a forced void exit: those aren't discretionary, and a position
    // above the turnover-cap-as-fraction-of-NAV (e.g. T2's 8% max position
    // against a 3% turnover cap) could otherwise never exit on its own stop,
    // no matter how far it fell.
    if (reason === "score_exit" && turnoverUsed + notional > turnoverCapNotional) continue;

    orders.push({ ticker: p.ticker, side: "sell", quantity: p.quantity, refPrice: price, reason });
    turnoverUsed += notional;
    cash += notional;
    positionsByTicker.delete(p.ticker);
    soldThisRun.add(p.ticker);
    const sector = sectorFor(p.ticker);
    if (sector) {
      sectorWeight.set(sector, Math.max(0, (sectorWeight.get(sector) ?? 0) - notional / nav));
    }
  }

  // ── Buys ───────────────────────────────────────────────────────────────
  const buyCandidates = candidates
    .filter((c) => c.score >= policy.buyThreshold)
    .filter((c) => activeWatchlist.has(c.ticker))
    .filter((c) => prices[c.ticker] != null)
    .filter((c) => positionWeight(c.ticker) < policy.maxPositionWeight - 1e-9)
    .filter((c) => !soldThisRun.has(c.ticker)) // F13 — an exit ends the position for this run
    .sort(
      (a, b) =>
        b.score - a.score ||
        tieBreak?.(a, b) ||
        hashTicker(a.ticker, tieBreakSeed) - hashTicker(b.ticker, tieBreakSeed),
    );

  for (const c of buyCandidates) {
    const price = prices[c.ticker]!;
    const addWeight = policy.maxPositionWeight - positionWeight(c.ticker);
    if (addWeight <= 0) continue;
    let notional = addWeight * nav;

    const sector = sectorFor(c.ticker);
    if (sector) {
      const room = policy.sectorCapPct - (sectorWeight.get(sector) ?? 0);
      if (room <= 0) continue; // sector already at cap — clipped
      notional = Math.min(notional, room * nav);
    }

    const turnoverRoom = turnoverCapNotional - turnoverUsed;
    if (turnoverRoom <= 0) break; // no turnover budget left this run
    notional = Math.min(notional, turnoverRoom);

    const cashRoom = cash - cashFloorAmount;
    if (cashRoom <= 0) continue;
    notional = Math.min(notional, cashRoom);

    const minNotional = policy.minPositionWeight * nav;
    if (notional < minNotional) continue; // too small to be worth opening/topping up

    const quantity = notional / price;
    if (quantity <= 0) continue;

    orders.push({ ticker: c.ticker, side: "buy", quantity, refPrice: price, reason: "score_entry" });
    turnoverUsed += notional;
    cash -= notional;
    if (sector) sectorWeight.set(sector, (sectorWeight.get(sector) ?? 0) + notional / nav);

    const existing = positionsByTicker.get(c.ticker);
    if (existing) {
      existing.avgCost = (existing.avgCost * existing.quantity + notional) / (existing.quantity + quantity);
      existing.quantity += quantity;
    } else {
      positionsByTicker.set(c.ticker, { ticker: c.ticker, quantity, avgCost: price, runsHeld: 0, highWater: price });
    }
  }

  return { orders, turnoverUsed: turnoverUsed / nav };
}

/**
 * FILL (§4.3): apply the flat slippage assumption against the account both
 * ways — a buy pays up, a sell receives less — and compute realized P&L for
 * sells (always a full exit in this phase, so `realizedPnl` is against the
 * position's whole quantity).
 */
export function fillOrders(
  orders: ProposedOrder[],
  avgCostByTicker: ReadonlyMap<string, number>,
): FilledOrder[] {
  return orders.map((o) => {
    const slippageBps = isMegaOrLargeCap(o.ticker) ? 5 : 15;
    const sign = o.side === "buy" ? 1 : -1;
    const fillPrice = o.refPrice * (1 + (sign * slippageBps) / 10_000);
    const notional = o.quantity * fillPrice;
    const realizedPnl =
      o.side === "sell"
        ? o.quantity * (fillPrice - (avgCostByTicker.get(o.ticker) ?? o.refPrice))
        : null;
    return { ...o, fillPrice, slippageBps, notional, realizedPnl };
  });
}

// ── ARBITRATE (§4.2 step 6, Phase 5) ────────────────────────────────────────

/** How close a buy's card score can be to the buy threshold and still count
 *  as "genuinely tied" (§4.2 step 6) rather than a clear signal. Score points,
 *  not a fraction — thresholds in PaperPolicy are already on the card-score
 *  scale (§3's table), so this stays on the same scale rather than inventing
 *  a normalized one. Chosen, not derived: the design doc names the *category*
 *  ("genuinely tied") without a number.
 *
 *  Narrowed from 5 to 3 (docs/paper-trading-v3.md §5.3): this codebase's real
 *  card distribution clusters into a handful of discrete values with gaps of
 *  4-8 points between them (e.g. 54 then 60), so a band of 5 could straddle
 *  an entire cluster and flag every buy in it as a tie — RISK's buyThreshold
 *  of 60 against the 54/60 clusters spent its whole arbitration budget on
 *  score ties that were never close calls, just landed on the wrong side of a
 *  5-wide window. 3 still catches a genuine near-miss without catching a
 *  whole cluster one step below the line. */
const BUY_TIE_BAND = 3;

/** How far a not-yet-stopped `score_exit` sell has to have closed the
 *  distance toward its stop, as a fraction of the stop's own pct, before it
 *  counts as "near its stop" (§4.2 step 6). 0 = at the position's basis
 *  (avgCost or highWater, per stopRule.kind), 1 = at the stop itself — a sell
 *  that has already reached 1 is a `reason: 'stop'` order, which is mandatory
 *  and never reaches arbitration (see the loop below). */
const NEAR_STOP_FRACTION = 0.8;

export type ArbitrationFlagReason = "score_tie" | "near_stop";

export interface ArbitrationCandidate {
  order: ProposedOrder;
  flagReason: ArbitrationFlagReason;
}

/**
 * Pick up to `maxCandidates` proposed orders that qualify for arbitration —
 * buys whose score is within `BUY_TIE_BAND` of the buy threshold, or
 * `score_exit` sells trading within `NEAR_STOP_FRACTION` of their stop.
 * `stop` and `void` sells are forced exits and never arbitrated (guardrail
 * #5 bounds the model's blast radius to trades that were discretionary in
 * the first place). Sorted closest-to-the-boundary first so a tight budget
 * spends its calls on the trades genuinely in question, not an arbitrary
 * subset.
 */
export function selectArbitrationCandidates(
  orders: ProposedOrder[],
  policy: PaperPolicy,
  positions: ReadonlyMap<string, EnginePosition>,
  scores: ReadonlyMap<string, number>,
  prices: Readonly<Record<string, number>>,
  maxCandidates: number,
): ArbitrationCandidate[] {
  if (maxCandidates <= 0) return [];

  const flagged: (ArbitrationCandidate & { margin: number })[] = [];

  for (const order of orders) {
    if (order.side === "buy") {
      const score = scores.get(order.ticker);
      if (score == null) continue;
      const margin = score - policy.buyThreshold;
      if (margin >= 0 && margin <= BUY_TIE_BAND) {
        flagged.push({ order, flagReason: "score_tie", margin });
      }
    } else if (order.reason === "score_exit") {
      const position = positions.get(order.ticker);
      const price = prices[order.ticker];
      if (!position || price == null) continue;
      const basis = policy.stopRule.kind === "fixed" ? position.avgCost : position.highWater;
      const stopDistance = basis * policy.stopRule.pct;
      if (stopDistance <= 0) continue;
      const closedFraction = (basis - price) / stopDistance; // 0 at basis, 1 at the stop
      if (closedFraction >= NEAR_STOP_FRACTION && closedFraction < 1) {
        flagged.push({ order, flagReason: "near_stop", margin: 1 - closedFraction });
      }
    }
  }

  flagged.sort((a, b) => a.margin - b.margin);
  return flagged.slice(0, maxCandidates).map(({ margin: _margin, ...c }) => c);
}

export interface ArbitrationResult {
  ticker: string;
  action: "veto" | "downsize" | "confirm";
  /** Fraction of the order's quantity to cut, 0 < downsizePct < 1. Only set
   *  when action === "downsize". */
  downsizePct?: number;
  model: string;
  /** The model's own one-line reasoning (docs/paper-trading-v3.md §4.2, F8).
   *  Absent when the model's response was unparseable — see
   *  lib/paper-arbitration.ts's parseArbitrationResponse for why that case is
   *  `undefined`, not an empty string. */
  why?: string;
}

/**
 * Apply arbitration results to the (already RANK/PROPOSE/CLIP'd) order list.
 * `confirm` and "no decision recorded for this ticker" are equivalent — both
 * leave the order untouched, matching "unparseable response = CONFIRM-none"
 * (§4.2 step 6).
 */
export function applyArbitrationResults(
  orders: ProposedOrder[],
  results: ReadonlyMap<string, ArbitrationResult>,
): ProposedOrder[] {
  const out: ProposedOrder[] = [];
  for (const order of orders) {
    const result = results.get(order.ticker);
    if (!result || result.action === "confirm") {
      out.push(order);
    } else if (result.action === "downsize" && result.downsizePct) {
      out.push({ ...order, quantity: order.quantity * (1 - result.downsizePct), reason: "seat_downsize" });
    }
    // action === "veto" (or a downsize with no usable pct): drop the order.
  }
  return out;
}

// ── CHAIR consensus (docs/paper-trading-v3.md §3) ───────────────────────────

/** One ticker's vote tally among the five seats that ran this exact
 *  (trade_date, slot) before CHAIR — see lib/paper-db.ts's `getSeatOrdersForSlot`
 *  for how these are gathered. `totalSeats` lets the threshold be expressed
 *  as a fraction even when fewer than 5 seats have reported (a partial run). */
export interface ConsensusVote {
  ticker: string;
  buyVotes: number;
  sellVotes: number;
  totalSeats: number;
}

/** Fraction of reporting seats that must agree before CHAIR acts on a name —
 *  "consensus of the five, weighted by agreement" (design doc §2), made
 *  concrete as 3 of 5. Expressed as a fraction, not a fixed count, so a
 *  partial run (fewer than 5 seats reported) still means something: 3 of 5
 *  reporting and agreeing still clears >=60%, but 3 of 3 and 3 of 4 do too. */
const CONSENSUS_FRACTION = 0.6;

/**
 * CHAIR's own plan: not scored against `buyThreshold`/`sellThreshold` at all
 * (§2/§11 Q1's design intent — CHAIR reads the *other seats' decisions*, not
 * a fresh card read), but still subject to CHAIR's own risk caps (position,
 * sector, turnover, cash floor) and its own stop, using the same CLIP
 * mechanics as `planRun`. A tied vote (exactly at the threshold with an odd
 * seat count) counts as consensus, matching `selectArbitrationCandidates`'
 * own >= convention elsewhere in this module.
 *
 * Sizing follows docs/paper-trading-v3.md §3: `5% * votes/5` of NAV, capped
 * by the account's own `maxPositionWeight` the same way a normal buy is.
 */
export function planChairConsensus(
  policy: PaperPolicy,
  nav: number,
  cash: number,
  positions: EnginePosition[],
  votes: ConsensusVote[],
  activeWatchlist: ReadonlySet<string>,
  prices: Readonly<Record<string, number>>,
): RunPlan {
  if (nav <= 0) return { orders: [], turnoverUsed: 0 };

  const voteByTicker = new Map(votes.map((v) => [v.ticker, v]));
  const positionsByTicker = new Map(positions.map((p) => [p.ticker, { ...p }]));
  const turnoverCapNotional = policy.maxTurnoverPerRun * nav;
  const cashFloorAmount = policy.cashFloor * nav;

  const sectorWeight = new Map<PaperSector, number>();
  for (const p of positions) {
    const price = prices[p.ticker] ?? p.avgCost;
    const sector = sectorFor(p.ticker);
    if (sector) sectorWeight.set(sector, (sectorWeight.get(sector) ?? 0) + (p.quantity * price) / nav);
  }

  const orders: ProposedOrder[] = [];
  let turnoverUsed = 0;
  let cashLeft = cash;
  const soldThisRun = new Set<string>();

  function positionWeight(ticker: string): number {
    const p = positionsByTicker.get(ticker);
    if (!p) return 0;
    const price = prices[ticker] ?? p.avgCost;
    return (p.quantity * price) / nav;
  }
  function hasConsensus(v: ConsensusVote | undefined, votesField: "buyVotes" | "sellVotes"): boolean {
    if (!v || v.totalSeats <= 0) return false;
    return v[votesField] / v.totalSeats >= CONSENSUS_FRACTION;
  }

  // ── Sells: CHAIR's own stop/void still fire regardless of consensus, since
  // consensus governs entries/exits on *signal*, not risk management CHAIR
  // owns itself; a seat-consensus sell is the fourth reason, checked last. ──
  for (const p of [...positionsByTicker.values()]) {
    const price = prices[p.ticker];
    if (price == null) continue;

    const forced = !activeWatchlist.has(p.ticker);
    const stopHit = isStopTriggered(policy, p, price);
    const consensusSell = hasConsensus(voteByTicker.get(p.ticker), "sellVotes");

    let reason: OrderReason | null = null;
    if (forced) reason = "void";
    else if (stopHit) reason = "stop";
    else if (consensusSell) reason = "score_exit"; // consensus-driven exit, same reason taxonomy

    if (!reason) continue;
    const notional = p.quantity * price;
    if (reason === "score_exit" && turnoverUsed + notional > turnoverCapNotional) continue;

    orders.push({ ticker: p.ticker, side: "sell", quantity: p.quantity, refPrice: price, reason });
    turnoverUsed += notional;
    cashLeft += notional;
    positionsByTicker.delete(p.ticker);
    soldThisRun.add(p.ticker);
    const sector = sectorFor(p.ticker);
    if (sector) sectorWeight.set(sector, Math.max(0, (sectorWeight.get(sector) ?? 0) - notional / nav));
  }

  // ── Buys: consensus-agreed names only, sized by how many seats agreed. ──
  const buyCandidates = votes
    .filter((v) => hasConsensus(v, "buyVotes"))
    .filter((v) => activeWatchlist.has(v.ticker))
    .filter((v) => prices[v.ticker] != null)
    .filter((v) => positionWeight(v.ticker) < policy.maxPositionWeight - 1e-9)
    .filter((v) => !soldThisRun.has(v.ticker))
    .sort((a, b) => b.buyVotes / b.totalSeats - a.buyVotes / a.totalSeats || a.ticker.localeCompare(b.ticker));

  for (const v of buyCandidates) {
    const price = prices[v.ticker]!;
    // §3: 5% of NAV, scaled by the agreement fraction. CodeRabbit review, PR
    // #204: dividing by a hard-coded 5 disagreed with the consensus filter
    // above, which uses v.totalSeats — under a partial run (fewer than 5
    // seats reported), 3-of-3 agreement passed the filter as 100% consensus
    // but sized as if only 3 of 5 had agreed (3%, not 5%). Same denominator
    // as the filter now.
    const votedWeight = 0.05 * (v.buyVotes / v.totalSeats);
    const addWeight = Math.min(votedWeight, policy.maxPositionWeight - positionWeight(v.ticker));
    if (addWeight <= 0) continue;
    let notional = addWeight * nav;

    const sector = sectorFor(v.ticker);
    if (sector) {
      const room = policy.sectorCapPct - (sectorWeight.get(sector) ?? 0);
      if (room <= 0) continue;
      notional = Math.min(notional, room * nav);
    }

    const turnoverRoom = turnoverCapNotional - turnoverUsed;
    if (turnoverRoom <= 0) break;
    notional = Math.min(notional, turnoverRoom);

    const cashRoom = cashLeft - cashFloorAmount;
    if (cashRoom <= 0) continue;
    notional = Math.min(notional, cashRoom);

    const minNotional = policy.minPositionWeight * nav;
    if (notional < minNotional) continue;

    const quantity = notional / price;
    if (quantity <= 0) continue;

    orders.push({ ticker: v.ticker, side: "buy", quantity, refPrice: price, reason: "score_entry" });
    turnoverUsed += notional;
    cashLeft -= notional;
    if (sector) sectorWeight.set(sector, (sectorWeight.get(sector) ?? 0) + notional / nav);

    const existing = positionsByTicker.get(v.ticker);
    if (existing) {
      existing.avgCost = (existing.avgCost * existing.quantity + notional) / (existing.quantity + quantity);
      existing.quantity += quantity;
    } else {
      positionsByTicker.set(v.ticker, { ticker: v.ticker, quantity, avgCost: price, runsHeld: 0, highWater: price });
    }
  }

  return { orders, turnoverUsed: turnoverUsed / nav };
}
