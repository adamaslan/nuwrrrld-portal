/**
 * portfolio-health-local — read `ticker_cards` for a watchlist and score it
 * with `lib/portfolio-health-policy.ts`.
 *
 * The I/O half of the local health path. See that policy module's header for
 * why a local path exists at all (upstream `/api/portfolio/health` has never
 * been deployed on gcp3).
 *
 * Portal-only, so this module is not in `lib/shared/` — that directory is
 * reserved for the declared base-URL seam mirrored with mobile
 * (check-shared-drift.mjs's gated set). This scoring policy has no mobile
 * counterpart today; a `lib/shared/` placement would have made it look
 * mirrored when it wasn't (2026-09-14 code-review finding on PR #123).
 */
import sql from "@/lib/db";
import type { OptimizerSuggestion, PortfolioHealth } from "@/lib/portfolio";
import {
  buildLocalHealth,
  buildLocalSuggestions,
  type HealthCardInput,
} from "@/lib/portfolio-health-policy";

/** Horizon the health score reads. `t1` is the short horizon — the one the
 *  portfolio panel's "how does my book look right now" question is asking. */
const HEALTH_HORIZON = "t1";

/**
 * Cards for the requested tickers, newest bar first.
 *
 * Uncovered tickers are simply absent from the result; the caller compares
 * against the requested list to compute coverage, so a missing card is visible
 * as missing rather than silently reducing the portfolio.
 */
async function readCards(
  tickers: string[],
): Promise<{ cards: HealthCardInput[]; barDate: string | null }> {
  // DISTINCT ON, not a plain filter: `ticker_cards` can retain more than one
  // row per (ticker, horizon) if nightly history isn't pruned, and without
  // this a ticker contributes multiple times to scoring and can push
  // coverage past the requested ticker count. ORDER BY bar_date DESC, ticker
  // makes the tie-breaker deterministic when two rows share a date.
  const rows = await sql`
    SELECT DISTINCT ON (ticker)
      ticker, universe, score, action, data_quality, bar_date
    FROM ticker_cards
    WHERE horizon = ${HEALTH_HORIZON}
      AND ticker = ANY(${tickers})
    ORDER BY ticker, bar_date DESC
  `;
  const cards: HealthCardInput[] = rows.map((r) => ({
    ticker: r.ticker as string,
    universe: r.universe as HealthCardInput["universe"],
    score: Number(r.score),
    action: r.action as HealthCardInput["action"],
    dataQuality: Number(r.data_quality),
  }));
  const barDates = rows
    .map((r) => (r.bar_date ? new Date(r.bar_date as string).toISOString().slice(0, 10) : null))
    .filter((d): d is string => d !== null)
    .sort();
  return { cards, barDate: barDates.length ? barDates[barDates.length - 1] : null };
}

/**
 * Locally-computed health for a watchlist, or `null` when nothing can be
 * scored (no cards, or the read failed).
 *
 * Never throws. This is the fallback path — a throw here would defeat the
 * point, since the caller reaches it precisely because something else already
 * failed.
 */
export async function localPortfolioHealth(
  tickers: string[],
): Promise<PortfolioHealth | null> {
  if (tickers.length === 0) return null;
  try {
    const { cards, barDate } = await readCards(tickers);
    return buildLocalHealth(tickers, cards, barDate);
  } catch (err) {
    console.error(
      `[portfolio-health] local_read_failed tickers=${tickers.length} err=${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Locally-computed optimizer suggestions. Never throws; `[]` on any failure. */
export async function localPortfolioSuggestions(
  tickers: string[],
): Promise<OptimizerSuggestion[]> {
  if (tickers.length === 0) return [];
  try {
    const { cards } = await readCards(tickers);
    return buildLocalSuggestions(cards, tickers.length);
  } catch (err) {
    console.error(
      `[portfolio-suggestions] local_read_failed err=${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
