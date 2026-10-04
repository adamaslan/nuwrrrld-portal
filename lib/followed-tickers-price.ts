/**
 * followed-tickers-price — the price chain for cohort entries and daily closes.
 * Follows the market-data-fallback order: live_prices → Alpaca latest trade →
 * latest daily_bars close.
 *
 * A rung is accepted only if its price is dated on or after `freshSince` (a New
 * York calendar date). Without that bound, a stale live_prices row would be
 * recorded as today's close, and the horizon math would be wrong with no error.
 * Every fall-through is logged with its reason, and every accepted price carries
 * its source into the pick or observation row.
 */
import { getLivePrice } from "@/lib/live-price-db";
import { fetchAlpacaLatestTrade } from "@/lib/alpaca-latest-price";
import { getLatestDailyBar, type PriceSource } from "@/lib/followed-tickers-db";

export interface FollowedPrice {
  price: number;
  source: PriceSource;
  /** New York calendar date the price belongs to (YYYY-MM-DD). */
  asOf: string;
}

const NY_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
const MS_PER_DAY = 86_400_000;

/** New York calendar date (YYYY-MM-DD) of an instant. The cohort and observer
 *  are keyed by NY trading day; a UTC date runs a day ahead after the 19:00 ET
 *  track run. */
export function nyDateOf(instant: Date): string {
  return NY_DATE_FORMAT.format(instant);
}

/** The NY calendar date `days` days before `now`, for a `freshSince` bound. */
export function nyDateDaysAgo(now: Date, days: number): string {
  return nyDateOf(new Date(now.getTime() - days * MS_PER_DAY));
}

/**
 * First rung of the chain that has a price on or after `freshSince`, or null.
 * Never throws: each rung's failure is already null, and a missing price is a
 * normal outcome the caller records as "skipped".
 */
export async function resolveFollowedPrice(
  ticker: string,
  freshSince: string,
): Promise<FollowedPrice | null> {
  const live = await getLivePrice(ticker);
  if (live && live.price > 0) {
    const asOf = nyDateOf(new Date(live.tradedAt));
    if (asOf >= freshSince) return { price: live.price, source: "live_prices", asOf };
    console.warn(`[followed-price] ${ticker}: live_prices dated ${asOf}, before ${freshSince}; falling back`);
  } else {
    console.warn(`[followed-price] ${ticker}: no live_prices row; falling back`);
  }

  const alpaca = await fetchAlpacaLatestTrade(ticker);
  if (alpaca) {
    const asOf = nyDateOf(new Date(alpaca.tradedAt));
    if (asOf >= freshSince) return { price: alpaca.price, source: "alpaca_iex", asOf };
    console.warn(`[followed-price] ${ticker}: Alpaca trade dated ${asOf}, before ${freshSince}; falling back`);
  }

  const bar = await getLatestDailyBar(ticker);
  if (bar && bar.close > 0 && bar.barDate >= freshSince) {
    console.warn(`[followed-price] ${ticker}: using daily_bars close from ${bar.barDate}`);
    return { price: bar.close, source: "daily_bars", asOf: bar.barDate };
  }

  console.warn(`[followed-price] ${ticker}: no fresh price from any source since ${freshSince}`);
  return null;
}
