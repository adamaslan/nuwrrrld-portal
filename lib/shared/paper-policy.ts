/**
 * Council paper-portfolio preference vectors (docs/council-paper-portfolios.md §3).
 *
 * The persona must be mechanical, not a prompt: sizing left to the model would
 * make four runs a day across eight accounts unreproducible and expensive. So
 * each seat gets this explicit vector and the model's job (Phase 5's
 * arbitration step) shrinks to breaking ties — veto / downsize / confirm.
 *
 * Pure and DB-free — same rationale as lib/shared/public-demo-policy.ts and
 * lib/shared/card-policy.ts: unit-testable without pulling in `@/lib/db`.
 */
import type { CouncilSeat } from "../openrouter";

/** Bump on any change to the vectors below — carried onto paper_accounts.policy_version
 *  and paper_runs.policy_version so a NAV series can always be read against the
 *  policy that produced it.
 *
 *  v2 (2026-09-26): buy/sell thresholds re-expressed on scoreCard's [-100, 100]
 *  scale via x -> 2x - 100. v1 read like a 0-100 scale, and against real cards
 *  (watchlist max 60, mean 4.5) it could never trigger a buy.
 *
 *  v3 (docs/paper-trading-v3.md §5.3, 2026-09-29): thresholds moved off the
 *  actual score clusters they landed on. The real distribution on 2026-09-29
 *  (978 cards) clustered at {..., 45, 46, 50, 51, 54, 60, 100} — v2's
 *  thresholds (40/20/60/30/50/40) sat exactly on top of several of those
 *  clusters, which is why every trading account either bought the same
 *  cluster or bought nothing at all (F3). Every number below is *chosen*
 *  against that specific distribution, not derived — restated here so a
 *  future distribution shift doesn't get inherited silently. Paired with
 *  the persona tie-breaks (lib/shared/paper-persona.ts): raising a threshold
 *  alone does not diverge the six books' *picks* (verified with
 *  scripts/paper-sim.ts --policy=v3 before this bump — still 6/6 on the same
 *  name), only the tie-break rule does that; this bump exists for the second
 *  half of §5.3's argument — moving buy/sell bands off the score clusters so
 *  a threshold actually discriminates instead of landing on a cliff edge —
 *  and for T2's turnover/hold-period fixes below, which are unrelated to
 *  tie-breaking. RISK's threshold is intentionally left at v2's 60, not the
 *  doc's originally-floated 55: measurement (§5.3's own table) showed 55
 *  still falls inside the (now-narrowed) BUY_TIE_BAND and clears the same 4
 *  names as 60 — the real fix for RISK's arbitration load was narrowing
 *  BUY_TIE_BAND (paper-engine-core.ts), not moving this number.
 *
 *  v4 (docs/paper-trading-v3.md §3.1, 2026-09-29): every trading account
 *  gets a holdings floor (`minHoldings`, 15+) filled from its own persona
 *  starter book (lib/shared/paper-core-books.ts) at `coreWeight` each.
 *  Production on 2026-09-29 held 0–4 names per account — a "book" of three
 *  tickers is a single bet, not a strategy, and it made every account's P&L
 *  a function of whichever one name crossed its threshold (6/6 on UNH).
 *  RISK's sellThreshold moves 10 -> 0 in the same bump: 784 of 978 live
 *  cards score exactly 0 (neutral), so "exit below 10" meant RISK dumped
 *  every neutral staple and utility it is *supposed* to own, and could
 *  never hold more than the ~16 watchlist names scoring >= 10. Survive-
 *  being-wrong is enforced by its 5% trailing stop, 15% cash floor and 3%
 *  cap — not by selling a name for being quiet. It now exits the moment a
 *  card turns bearish (< 0). */
export const PAPER_POLICY_VERSION = "v4";

/**
 * `paper_accounts.account`'s own values (schema §5) — lowercase, distinct
 * from CouncilSeat (`"T1"`, uppercase, the `seat` column on the same row).
 * Don't conflate the two: `t1` the account and `T1` the seat are related by
 * `ACCOUNT_SEAT`, not by string case alone.
 */
export type PaperAccount = "t1" | "t2" | "risk" | "macro" | "quant" | "chair" | "equal" | "spy";

export const TRADING_ACCOUNTS: PaperAccount[] = ["t1", "t2", "risk", "macro", "quant", "chair"];

/** All eight accounts, in the design doc's own §2 table order. */
export const PAPER_ACCOUNTS: PaperAccount[] = [...TRADING_ACCOUNTS, "equal", "spy"];

export type TradingAccount = "t1" | "t2" | "risk" | "macro" | "quant" | "chair";

/** account -> seat, for the five that trade under a council persona. Used to
 *  call runSeat() (Phase 5) and to populate paper_accounts.seat at seed time. */
export const ACCOUNT_SEAT: Record<TradingAccount, CouncilSeat> = {
  t1: "T1",
  t2: "T2",
  risk: "RISK",
  macro: "MACRO",
  quant: "QUANT",
  chair: "CHAIR",
};

export type CardHorizon = "t1" | "t2" | "both";

export interface StopRule {
  kind: "fixed" | "trailing";
  /** Fractional loss from entry (fixed) or from the position's high-water mark
   *  (trailing) that forces an exit, e.g. 0.08 for T1's "-8% from entry". */
  pct: number;
}

export interface PaperPolicy {
  cardHorizon: CardHorizon;
  /** Card score at/above which a candidate may be entered. */
  buyThreshold: number;
  /** Card score below which a held position is exited on signal alone. */
  sellThreshold: number;
  /** Max weight (fraction of NAV) any single position may reach. */
  maxPositionWeight: number;
  /** Min weight a new position must clear to be worth opening. */
  minPositionWeight: number;
  /** Min cash (fraction of NAV) the account must always hold. */
  cashFloor: number;
  /** Max total order notional (fraction of NAV) in a single run. */
  maxTurnoverPerRun: number;
  /** Minimum number of runs a position must be held before it can be sold on
   *  signal (a stop or an invalidation can still force an exit sooner). */
  minHoldingPeriodRuns: number;
  stopRule: StopRule;
  /** Max weight (fraction of NAV) any single sector may reach. */
  sectorCapPct: number;
  /** Minimum ticker_cards.data_quality a candidate must clear to be screened in. */
  dataQualityGate: number;
  /** Ceiling on arbitration-layer model calls in a single run (§4.2). */
  maxModelCallsPerRun: number;
  /** v4: the fewest distinct positions the account may hold after a run.
   *  Below it, the planner fills from the account's persona starter book
   *  (lib/shared/paper-core-books.ts) before any score-driven buy — see
   *  `fillHoldingsFloor` in paper-engine-core.ts. */
  minHoldings: number;
  /** v4: target weight (fraction of NAV) of each floor-fill position.
   *  `minHoldings * coreWeight` is the account's invested core; the rest of
   *  NAV above `cashFloor` is dry powder for score-driven trades. */
  coreWeight: number;
}

/**
 * docs/council-paper-portfolios.md §3's table, transcribed verbatim. Do not
 * re-derive these from anything at runtime — they are the persona.
 */
export const PAPER_POLICY: Record<TradingAccount, PaperPolicy> = {
  t1: {
    cardHorizon: "t1",
    buyThreshold: 45, // v2: 40 — sat on the 45/46 cluster's low edge
    sellThreshold: -10,
    maxPositionWeight: 0.06,
    minPositionWeight: 0.005,
    cashFloor: 0.02,
    maxTurnoverPerRun: 0.15,
    minHoldingPeriodRuns: 1,
    stopRule: { kind: "fixed", pct: 0.08 },
    sectorCapPct: 0.25,
    dataQualityGate: 0.8,
    maxModelCallsPerRun: 6,
    minHoldings: 16, // v4 — 16 x 4% = 64% core, ~34% dry powder for catalysts
    coreWeight: 0.04,
  },
  t2: {
    cardHorizon: "t2",
    buyThreshold: 45, // v2: 20 — "buy anything bullish" against the real distribution
    sellThreshold: -35, // v2: -40
    maxPositionWeight: 0.08,
    minPositionWeight: 0.01,
    cashFloor: 0,
    // v2: 0.03 — smaller than maxPositionWeight, which is exactly the shape
    // F5's fixed stop bug needed (a full 8% position could never exit under
    // a 3% cap). The engine fix (paper-engine-core.ts) means a stop now
    // bypasses this cap regardless, but 6% still reduces how often a
    // deliberate signal exit gets clipped for a reason that was never about
    // risk, just an accidental policy-shape collision.
    maxTurnoverPerRun: 0.06,
    minHoldingPeriodRuns: 20, // ~5 trading days at 4 runs/day, not "20 runs ~ months" as the label implied
    stopRule: { kind: "fixed", pct: 0.25 },
    sectorCapPct: 0.3,
    dataQualityGate: 0.8,
    maxModelCallsPerRun: 4,
    minHoldings: 20, // v4 — 20 x 4.5% = 90% — a compounder is fully invested and waits
    coreWeight: 0.045,
  },
  risk: {
    cardHorizon: "t2",
    buyThreshold: 60, // unchanged — see the version-doc comment above for why
    sellThreshold: 0, // v4: 10 — see the v4 note on PAPER_POLICY_VERSION
    maxPositionWeight: 0.03,
    minPositionWeight: 0.01,
    cashFloor: 0.15,
    maxTurnoverPerRun: 0.08,
    minHoldingPeriodRuns: 4,
    stopRule: { kind: "trailing", pct: 0.05 },
    sectorCapPct: 0.15,
    dataQualityGate: 0.9,
    maxModelCallsPerRun: 6,
    minHoldings: 20, // v4 — 20 x 3% = 60% core + 15% floor: many small bets, none fatal
    coreWeight: 0.03,
  },
  macro: {
    cardHorizon: "t2",
    buyThreshold: 45, // v2: 30 — below the 45/46 cluster, so ETF rotation names barely cleared it
    sellThreshold: -20,
    maxPositionWeight: 0.06,
    minPositionWeight: 0.005,
    cashFloor: 0.05,
    maxTurnoverPerRun: 0.1, // v2: 0.06 — one buy exhausted the whole run's budget every time
    minHoldingPeriodRuns: 8,
    stopRule: { kind: "fixed", pct: 0.15 },
    // Rotation is the thesis — the widest sector cap on purpose.
    sectorCapPct: 0.35,
    dataQualityGate: 0.8,
    maxModelCallsPerRun: 6,
    minHoldings: 15, // v4 — 15 x 4% = 60%; 8 ETFs = 32%, under the 35% ETF bucket cap
    coreWeight: 0.04,
  },
  quant: {
    cardHorizon: "both",
    buyThreshold: 50,
    sellThreshold: 0,
    maxPositionWeight: 0.04,
    minPositionWeight: 0.01,
    cashFloor: 0,
    maxTurnoverPerRun: 0.12,
    minHoldingPeriodRuns: 1,
    stopRule: { kind: "fixed", pct: 0.1 },
    sectorCapPct: 0.25,
    dataQualityGate: 0.95,
    // Zero model calls by construction — QUANT's mandate is "interpret only
    // the numeric DATA," so it is the deterministic control inside the
    // council and never reaches the arbitration step.
    maxModelCallsPerRun: 0,
    minHoldings: 15, // v4 — 15 x 4% = 60%, filled by score alone (no curated list)
    coreWeight: 0.04,
  },
  chair: {
    cardHorizon: "both",
    buyThreshold: 45, // v2: 40 — CHAIR's own plan always comes from
    // planChairConsensus (paper-engine-core.ts), never planRun, so this
    // field is unused for entry/exit decisions; kept at the same shape as
    // every other trading account's policy (cash floor, turnover, sector cap
    // etc. below are all real and still enforced on chair's consensus buys)
    // rather than special-casing PaperPolicy's type for one account.
    sellThreshold: -10,
    maxPositionWeight: 0.05,
    minPositionWeight: 0.01,
    cashFloor: 0.05,
    maxTurnoverPerRun: 0.08,
    minHoldingPeriodRuns: 4,
    stopRule: { kind: "fixed", pct: 0.12 },
    sectorCapPct: 0.25,
    dataQualityGate: 0.85,
    maxModelCallsPerRun: 8,
    minHoldings: 18, // v4 — 18 x 4% = 72% — a seat-weighted sample of the council
    coreWeight: 0.04,
  },
};

/** Total arbitration-call ceiling across all eight accounts, per run (§4.2). */
export const MAX_MODEL_CALLS_PER_RUN_ALL_ACCOUNTS = 36;
/** Same ceiling, rolled up across the four daily slots (settle makes none). */
export const MAX_MODEL_CALLS_PER_DAY_ALL_ACCOUNTS = 108;

export function isTradingAccount(account: PaperAccount): account is TradingAccount {
  return (TRADING_ACCOUNTS as PaperAccount[]).includes(account);
}

/** `equal` and `spy` never trade after seed — no policy applies to them. */
export function policyFor(account: PaperAccount): PaperPolicy | null {
  return isTradingAccount(account) ? PAPER_POLICY[account] : null;
}
