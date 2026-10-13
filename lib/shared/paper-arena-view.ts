/**
 * paper-arena-view — pure view-model builder for the all-eight-accounts
 * comparison page (`/dashboard/council/portfolios/arena`).
 *
 * Answers three questions the per-account leaderboard doesn't:
 *   1. Which account is best, judged on more than raw return? (`judgeScore`)
 *   2. How did their equity curves diverge? (`curves`, rebased to 100)
 *   3. What did each one trade, and why? (`trades`, `reasonBreakdown`)
 *
 * No DB, no React — same split as paper-view.ts, so the API route and the
 * tests assemble from plain rows.
 */
import type { NavPoint, OrderRow, Position } from "@/lib/paper-db";
import type { PaperAccount } from "@/lib/shared/paper-policy";
import type { AccountMetrics } from "@/lib/shared/paper-view";

/** Plain-English gloss for every `paper_orders.reason` the engine writes. */
export const REASON_LABELS: Record<string, string> = {
  score_entry: "Bought: card score cleared the buy threshold",
  score_exit: "Sold: card score fell below the sell threshold",
  stop: "Sold: stop-loss / trailing stop hit",
  void: "Sold: thesis invalidated",
  cap_clip: "Resized: position or sector cap clipped the order",
  seat_downsize: "Resized: council seat downsized the order",
  core_fill: "Bought: filled the holdings floor from the persona starter book",
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

export interface ArenaMetricColumn {
  key: JudgeKey;
  label: string;
  /** Which direction wins — drives best-in-column highlighting and ranking. */
  better: "higher" | "lower";
  /** Short note on what the number means, shown as a tooltip. */
  hint: string;
}

/** The five metrics the composite judge score ranks on, in display order. */
export type JudgeKey = "totalReturnPct" | "sharpeRf0" | "maxDrawdownPct" | "hitRatePct" | "activeReturnVsSpyPct";

export const JUDGE_COLUMNS: ArenaMetricColumn[] = [
  { key: "totalReturnPct", label: "Return", better: "higher", hint: "Total return since seeding." },
  { key: "sharpeRf0", label: "Sharpe", better: "higher", hint: "Return per unit of volatility (risk-free = 0)." },
  { key: "maxDrawdownPct", label: "Max DD", better: "higher", hint: "Worst peak-to-trough fall (closer to 0 is better)." },
  { key: "hitRatePct", label: "Hit rate", better: "higher", hint: "Share of closed positions that made money." },
  { key: "activeReturnVsSpyPct", label: "vs SPY", better: "higher", hint: "Return minus the SPY buy-and-hold account." },
];

export interface ArenaRowVM {
  account: PaperAccount;
  seat: string | null;
  label: string;
  isBaseline: boolean;
  nav: number;
  cash: number;
  cashPct: number | null;
  positionsN: number;
  totalReturnPct: number | null;
  dayReturnPct: number | null;
  sharpeRf0: number | null;
  annualizedVolPct: number | null;
  maxDrawdownPct: number | null;
  hitRatePct: number | null;
  closedPositions: number;
  avgWin: number | null;
  avgLoss: number | null;
  /** avgWin / |avgLoss| — null when either side is missing or loss is 0. */
  payoffRatio: number | null;
  turnoverPct: number | null;
  avgHoldingPeriodDays: number | null;
  activeReturnVsSpyPct: number | null;
  activeReturnVsEqualPct: number | null;
  /** Mean rank (1 = best) across `JUDGE_COLUMNS`; null when nothing is rankable. */
  judgeScore: number | null;
  /** 1-based overall rank by `judgeScore` among accounts that have one. */
  judgeRank: number | null;
  /** Columns in which this account is the single best (ties share the badge). */
  bestIn: JudgeKey[];
}

export interface CurvePointVM {
  /** `YYYY-MM-DD` of the settle NAV mark. */
  date: string;
  /** NAV rebased so the account's first point is 100. */
  indexed: number;
}

export interface TradeVM {
  id: string;
  account: PaperAccount;
  when: string;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  fillPrice: number;
  notional: number;
  realizedPnl: number | null;
  reason: string;
  reasonText: string;
  decidedBy: string;
  model: string | null;
  cardScore: number | null;
  /** The position's recorded thesis, when the ticker is still held. */
  thesis: string | null;
}

export interface ReasonStatVM {
  reason: string;
  reasonText: string;
  count: number;
  realizedPnl: number;
}

export interface ArenaAccountInput {
  account: PaperAccount;
  seat: string | null;
  label: string;
  cash: number;
  metrics: AccountMetrics | null;
  /** Oldest-first settle (or any-slot) NAV marks. */
  nav: NavPoint[];
  latestNav: NavPoint | null;
  orders: OrderRow[];
  positions: Position[];
}

export interface ArenaVM {
  rows: ArenaRowVM[];
  curves: Partial<Record<PaperAccount, CurvePointVM[]>>;
  trades: TradeVM[];
  reasonBreakdown: Partial<Record<PaperAccount, ReasonStatVM[]>>;
  generatedAt: string;
}

const BASELINES: ReadonlySet<PaperAccount> = new Set<PaperAccount>(["equal", "spy"]);
const TRADE_FEED_LIMIT = 200;

function pct(v: number | null | undefined): number | null {
  return v == null ? null : v * 100;
}

/** 1-based ranks; ties share the best (lowest) rank. Nulls are unranked. */
export function rankValues(values: (number | null)[], better: "higher" | "lower"): (number | null)[] {
  return values.map((v) => {
    if (v == null) return null;
    const ahead = values.filter((o) => o != null && (better === "higher" ? o > v : o < v)).length;
    return ahead + 1;
  });
}

function buildRow(input: ArenaAccountInput): ArenaRowVM {
  const m = input.metrics;
  const latest = input.latestNav;
  const nav = latest?.nav ?? input.cash;
  const totalReturn = latest?.totalReturn ?? m?.totalReturn ?? null;
  const avgWin = m?.avgWin ?? null;
  const avgLoss = m?.avgLoss ?? null;
  return {
    account: input.account,
    seat: input.seat,
    label: input.label,
    isBaseline: BASELINES.has(input.account),
    nav,
    cash: input.cash,
    cashPct: nav > 0 ? (input.cash / nav) * 100 : null,
    positionsN: latest?.positionsN ?? input.positions.length,
    totalReturnPct: pct(totalReturn),
    dayReturnPct: pct(latest?.dayReturn),
    sharpeRf0: m?.sharpeRf0 ?? null,
    annualizedVolPct: pct(m?.annualizedVol),
    maxDrawdownPct: pct(m?.maxDrawdown),
    hitRatePct: pct(m?.hitRate),
    closedPositions: m?.closedPositions ?? 0,
    avgWin,
    avgLoss,
    payoffRatio: avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    turnoverPct: pct(m?.rollingTurnover),
    avgHoldingPeriodDays: m?.avgHoldingPeriodDays ?? null,
    activeReturnVsSpyPct: pct(m?.activeReturnVsSpy),
    activeReturnVsEqualPct: pct(m?.activeReturnVsEqual),
    judgeScore: null,
    judgeRank: null,
    bestIn: [],
  };
}

/** Fills `judgeScore`, `judgeRank` and `bestIn` in place. Ranks only the six
 *  trading accounts: the two baselines are the yardsticks, not contestants,
 *  though they still appear in the table. */
function applyJudging(rows: ArenaRowVM[]): void {
  const contestants = rows.filter((r) => !r.isBaseline);
  const perColumnRanks = JUDGE_COLUMNS.map((col) =>
    rankValues(contestants.map((r) => r[col.key]), col.better),
  );
  contestants.forEach((row, i) => {
    const ranks = perColumnRanks.map((r) => r[i]).filter((r): r is number => r != null);
    row.judgeScore = ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;
    row.bestIn = JUDGE_COLUMNS.filter((_, c) => perColumnRanks[c][i] === 1 && contestants.length > 1).map((c) => c.key);
  });
  const scores = contestants.map((r) => r.judgeScore);
  const overall = rankValues(scores, "lower");
  contestants.forEach((row, i) => {
    row.judgeRank = overall[i];
  });
}

function buildCurve(nav: NavPoint[]): CurvePointVM[] {
  if (nav.length === 0) return [];
  const base = nav[0].nav;
  if (!(base > 0)) return [];
  return nav.map((p) => ({ date: p.tradeDate, indexed: (p.nav / base) * 100 }));
}

function buildTrades(input: ArenaAccountInput): TradeVM[] {
  const thesisByTicker = new Map(input.positions.map((p) => [p.ticker, p.thesis]));
  return input.orders.map((o) => ({
    id: o.id,
    account: o.account,
    when: o.createdAt,
    ticker: o.ticker,
    side: o.side,
    quantity: o.quantity,
    fillPrice: o.fillPrice,
    notional: o.notional,
    realizedPnl: o.realizedPnl,
    reason: o.reason,
    reasonText: reasonLabel(o.reason),
    decidedBy: o.decidedBy,
    model: o.model,
    cardScore: o.cardScore,
    thesis: thesisByTicker.get(o.ticker) ?? null,
  }));
}

function buildReasonStats(orders: OrderRow[]): ReasonStatVM[] {
  const byReason = new Map<string, ReasonStatVM>();
  for (const o of orders) {
    const stat = byReason.get(o.reason) ?? { reason: o.reason, reasonText: reasonLabel(o.reason), count: 0, realizedPnl: 0 };
    stat.count += 1;
    stat.realizedPnl += o.realizedPnl ?? 0;
    byReason.set(o.reason, stat);
  }
  return [...byReason.values()].sort((a, b) => b.count - a.count);
}

export function buildArenaView(inputs: ArenaAccountInput[], now: Date = new Date()): ArenaVM {
  const rows = inputs.map(buildRow);
  applyJudging(rows);
  // Contestants by judge rank first, unranked after, baselines last.
  rows.sort((a, b) => {
    if (a.isBaseline !== b.isBaseline) return a.isBaseline ? 1 : -1;
    if (a.judgeRank == null) return b.judgeRank == null ? 0 : 1;
    if (b.judgeRank == null) return -1;
    return a.judgeRank - b.judgeRank;
  });

  const curves: ArenaVM["curves"] = {};
  const reasonBreakdown: ArenaVM["reasonBreakdown"] = {};
  const allTrades: TradeVM[] = [];
  for (const input of inputs) {
    curves[input.account] = buildCurve(input.nav);
    reasonBreakdown[input.account] = buildReasonStats(input.orders);
    allTrades.push(...buildTrades(input));
  }
  allTrades.sort((a, b) => b.when.localeCompare(a.when));

  return { rows, curves, trades: allTrades.slice(0, TRADE_FEED_LIMIT), reasonBreakdown, generatedAt: now.toISOString() };
}
