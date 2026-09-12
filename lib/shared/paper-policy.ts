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
 *  policy that produced it. */
export const PAPER_POLICY_VERSION = "v1";

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
}

/**
 * docs/council-paper-portfolios.md §3's table, transcribed verbatim. Do not
 * re-derive these from anything at runtime — they are the persona.
 */
export const PAPER_POLICY: Record<TradingAccount, PaperPolicy> = {
  t1: {
    cardHorizon: "t1",
    buyThreshold: 70,
    sellThreshold: 45,
    maxPositionWeight: 0.06,
    minPositionWeight: 0.005,
    cashFloor: 0.02,
    maxTurnoverPerRun: 0.15,
    minHoldingPeriodRuns: 1,
    stopRule: { kind: "fixed", pct: 0.08 },
    sectorCapPct: 0.25,
    dataQualityGate: 0.8,
    maxModelCallsPerRun: 6,
  },
  t2: {
    cardHorizon: "t2",
    buyThreshold: 60,
    sellThreshold: 30,
    maxPositionWeight: 0.08,
    minPositionWeight: 0.01,
    cashFloor: 0,
    maxTurnoverPerRun: 0.03,
    minHoldingPeriodRuns: 20,
    stopRule: { kind: "fixed", pct: 0.25 },
    sectorCapPct: 0.3,
    dataQualityGate: 0.8,
    maxModelCallsPerRun: 4,
  },
  risk: {
    cardHorizon: "t2",
    buyThreshold: 80,
    sellThreshold: 55,
    maxPositionWeight: 0.03,
    minPositionWeight: 0.01,
    cashFloor: 0.15,
    maxTurnoverPerRun: 0.08,
    minHoldingPeriodRuns: 4,
    stopRule: { kind: "trailing", pct: 0.05 },
    sectorCapPct: 0.15,
    dataQualityGate: 0.9,
    maxModelCallsPerRun: 6,
  },
  macro: {
    cardHorizon: "t2",
    buyThreshold: 65,
    sellThreshold: 40,
    maxPositionWeight: 0.06,
    minPositionWeight: 0.005,
    cashFloor: 0.05,
    maxTurnoverPerRun: 0.06,
    minHoldingPeriodRuns: 8,
    stopRule: { kind: "fixed", pct: 0.15 },
    // Rotation is the thesis — the widest sector cap on purpose.
    sectorCapPct: 0.35,
    dataQualityGate: 0.8,
    maxModelCallsPerRun: 6,
  },
  quant: {
    cardHorizon: "both",
    buyThreshold: 75,
    sellThreshold: 50,
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
  },
  chair: {
    cardHorizon: "both",
    buyThreshold: 70,
    sellThreshold: 45,
    maxPositionWeight: 0.05,
    minPositionWeight: 0.01,
    cashFloor: 0.05,
    maxTurnoverPerRun: 0.08,
    minHoldingPeriodRuns: 4,
    stopRule: { kind: "fixed", pct: 0.12 },
    sectorCapPct: 0.25,
    dataQualityGate: 0.85,
    maxModelCallsPerRun: 8,
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
