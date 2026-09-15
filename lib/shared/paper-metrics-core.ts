/**
 * paper-metrics-core — pure scoring for the paper-portfolio simulation
 * (docs/council-paper-portfolios.md §7, Phase 8 of
 * docs/paper-portfolios-remaining-todo.md).
 *
 * No I/O, same split as lib/shared/paper-engine-core.ts vs lib/paper-engine.ts:
 * `lib/paper-metrics.ts` reads the NAV/order rows and calls into this module,
 * which is unit-testable against fixture arrays directly.
 *
 * CAGR / annualized vol / Sharpe(rf=0) / max drawdown formulas match
 * docs/moo-council-run/sim_moo.py's `lump()` exactly (§7: "Sharpe (rf = 0,
 * matching docs/moo-council-run/sim_moo.py)") — same shape, ported from
 * pandas to plain arrays.
 *
 * Known simplification: holding period is derived from order history, not a
 * stored field — a sell is always a full exit (lib/shared/paper-engine-core.ts's
 * own documented simplification), so "when did this closed position open" is
 * unambiguous: the earliest buy for that ticker since the position was last
 * flat. Multiple top-up buys before the eventual sell all count from that
 * first buy, not a lot-weighted average entry time.
 */

export interface MetricsNavPoint {
  tradeDate: string;
  nav: number;
}

export interface MetricsOrder {
  ticker: string;
  side: "buy" | "sell";
  createdAt: string;
  realizedPnl: number | null;
}

const TRADING_DAYS_PER_YEAR = 252;

/** (end/start)^(1/years) - 1, over the actual calendar span between the first
 *  and last point — matches sim_moo.py's `cagr()`. Null when there isn't
 *  enough series (< 2 points, or the span rounds to 0 years) to mean anything. */
export function computeCagr(nav: MetricsNavPoint[]): number | null {
  if (nav.length < 2) return null;
  const first = nav[0];
  const last = nav[nav.length - 1];
  if (first.nav <= 0 || last.nav <= 0) return null;
  const years =
    (new Date(last.tradeDate).getTime() - new Date(first.tradeDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (years <= 0) return null;
  return Math.pow(last.nav / first.nav, 1 / years) - 1;
}

/** Day-over-day fractional NAV changes, in series order. */
export function dailyReturns(nav: MetricsNavPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < nav.length; i++) {
    const prev = nav[i - 1].nav;
    if (prev > 0) out.push(nav[i].nav / prev - 1);
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation (n-1 denominator, matching pandas' `.std()`
 *  default, which is what sim_moo.py calls). */
function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Annualized volatility: std(daily returns) * sqrt(252). Null under 2 points. */
export function computeAnnualizedVol(nav: MetricsNavPoint[]): number | null {
  const returns = dailyReturns(nav);
  if (returns.length < 2) return null;
  return stdDev(returns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Sharpe, rf=0: mean(daily returns) / std(daily returns) * sqrt(252). Null
 *  when std is 0 (a flat or single-point series) or under 2 points. */
export function computeSharpeRf0(nav: MetricsNavPoint[]): number | null {
  const returns = dailyReturns(nav);
  if (returns.length < 2) return null;
  const sd = stdDev(returns);
  if (sd === 0) return null;
  return (mean(returns) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Max drawdown (most negative peak-to-trough dip, a fraction <= 0) and the
 *  current drawdown (from the running peak to the series' last point). Both
 *  null on an empty series. */
export function computeDrawdowns(nav: MetricsNavPoint[]): { maxDrawdown: number | null; currentDrawdown: number | null } {
  if (nav.length === 0) return { maxDrawdown: null, currentDrawdown: null };
  let peak = nav[0].nav;
  let maxDrawdown = 0;
  for (const point of nav) {
    peak = Math.max(peak, point.nav);
    if (peak > 0) maxDrawdown = Math.min(maxDrawdown, point.nav / peak - 1);
  }
  const currentDrawdown = peak > 0 ? nav[nav.length - 1].nav / peak - 1 : null;
  return { maxDrawdown, currentDrawdown };
}

export interface HitRateStats {
  closedPositions: number;
  hitRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
}

/** Hit rate + average win/loss over every sell (a sell is always a full exit,
 *  so one sell === one closed position). Wins/losses are `realizedPnl`
 *  strictly greater/less than 0; a flat exit (exactly 0) counts toward
 *  `closedPositions` but neither bucket. */
export function computeHitRateStats(orders: MetricsOrder[]): HitRateStats {
  const sells = orders.filter((o) => o.side === "sell" && o.realizedPnl != null);
  if (sells.length === 0) {
    return { closedPositions: 0, hitRate: null, avgWin: null, avgLoss: null };
  }
  const wins = sells.filter((o) => (o.realizedPnl as number) > 0);
  const losses = sells.filter((o) => (o.realizedPnl as number) < 0);
  return {
    closedPositions: sells.length,
    hitRate: wins.length / sells.length,
    avgWin: wins.length > 0 ? mean(wins.map((o) => o.realizedPnl as number)) : null,
    avgLoss: losses.length > 0 ? mean(losses.map((o) => o.realizedPnl as number)) : null,
  };
}

/** Average holding period, in calendar days, across every closed position.
 *  Walks the order sequence per ticker: the position's "opened" timestamp is
 *  the first buy since it was last flat; a sell closes it and resets that
 *  ticker. Orders must already be in chronological order. Null when no
 *  position has ever closed. */
export function computeAvgHoldingPeriodDays(orders: MetricsOrder[]): number | null {
  const openedAt = new Map<string, string>();
  const holdingDays: number[] = [];
  for (const o of orders) {
    if (o.side === "buy") {
      if (!openedAt.has(o.ticker)) openedAt.set(o.ticker, o.createdAt);
    } else {
      const opened = openedAt.get(o.ticker);
      if (opened) {
        const days = (new Date(o.createdAt).getTime() - new Date(opened).getTime()) / (24 * 60 * 60 * 1000);
        holdingDays.push(days);
        openedAt.delete(o.ticker);
      }
    }
  }
  return holdingDays.length > 0 ? mean(holdingDays) : null;
}

export interface AccountMetrics {
  totalReturn: number | null;
  dayReturn: number | null;
  cagr: number | null;
  annualizedVol: number | null;
  sharpeRf0: number | null;
  maxDrawdown: number | null;
  currentDrawdown: number | null;
  closedPositions: number;
  hitRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  rollingTurnover: number | null;
  avgHoldingPeriodDays: number | null;
  /** null until `spy`'s own total return is known to the caller. */
  activeReturnVsSpy: number | null;
  activeReturnVsEqual: number | null;
}

/**
 * Assemble every §7 figure for one account. `latestTotalReturn`/`dayReturn`
 * come from the account's own most recent NAV point rather than being
 * re-derived here, since `paper_nav.total_return`/`day_return` are already
 * the authoritative per-run figures the engine computed (§4.2 step 9) — this
 * module only adds the series-level statistics that no single run row has.
 */
export function computeAccountMetrics(
  settleNav: MetricsNavPoint[],
  recentRunTurnovers: number[],
  orders: MetricsOrder[],
  latestTotalReturn: number | null,
  latestDayReturn: number | null,
  spyTotalReturn: number | null,
  equalTotalReturn: number | null,
): AccountMetrics {
  const { maxDrawdown, currentDrawdown } = computeDrawdowns(settleNav);
  const hitStats = computeHitRateStats(orders);
  return {
    totalReturn: latestTotalReturn,
    dayReturn: latestDayReturn,
    cagr: computeCagr(settleNav),
    annualizedVol: computeAnnualizedVol(settleNav),
    sharpeRf0: computeSharpeRf0(settleNav),
    maxDrawdown,
    currentDrawdown,
    closedPositions: hitStats.closedPositions,
    hitRate: hitStats.hitRate,
    avgWin: hitStats.avgWin,
    avgLoss: hitStats.avgLoss,
    rollingTurnover: recentRunTurnovers.length > 0 ? mean(recentRunTurnovers) : null,
    avgHoldingPeriodDays: computeAvgHoldingPeriodDays(orders),
    activeReturnVsSpy:
      latestTotalReturn != null && spyTotalReturn != null ? latestTotalReturn - spyTotalReturn : null,
    activeReturnVsEqual:
      latestTotalReturn != null && equalTotalReturn != null ? latestTotalReturn - equalTotalReturn : null,
  };
}
