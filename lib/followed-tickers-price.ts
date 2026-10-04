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
const NY_CLOCK_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const MS_PER_DAY = 86_400_000;
/** 16:00 ET, the regular-session close, as minutes past midnight. */
const NY_CLOSE_MINUTES = 16 * 60;

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

/** Minutes past NY midnight for an instant. */
function nyMinutesOf(instant: Date): number {
  const parts = NY_CLOCK_FORMAT.formatToParts(instant);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export interface PriceWindow {
  /** Oldest NY date a price may carry. */
  freshSince: string;
  /** When set, the price must belong to this NY date and have traded at or
   *  after the 16:00 ET close. The observer runs after the close, so a
   *  pre-close print is never recorded as the day's close. */
  closedOn?: string;
}

/** True if a quote traded at or after the close on the given NY date. */
function tradedAfterCloseOn(tradedAt: Date, closedOn: string): boolean {
  return nyDateOf(tradedAt) === closedOn && nyMinutesOf(tradedAt) >= NY_CLOSE_MINUTES;
}

/**
 * First rung of the chain that satisfies `window`, or null. Never throws: each
 * rung's failure is already null, and a missing price is a normal outcome the
 * caller records as "skipped".
 */
export async function resolveFollowedPrice(
  ticker: string,
  window: PriceWindow,
): Promise<FollowedPrice | null> {
  const { freshSince, closedOn } = window;

  const live = await getLivePrice(ticker);
  if (live && live.price > 0) {
    const tradedAt = new Date(live.tradedAt);
    const asOf = nyDateOf(tradedAt);
    if (asOf >= freshSince && (!closedOn || tradedAfterCloseOn(tradedAt, closedOn))) {
      return { price: live.price, source: "live_prices", asOf };
    }
    console.warn(`[followed-price] ${ticker}: live_prices traded ${live.tradedAt}, outside the window; falling back`);
  } else {
    console.warn(`[followed-price] ${ticker}: no live_prices row; falling back`);
  }

  const alpaca = await fetchAlpacaLatestTrade(ticker);
  if (alpaca) {
    const tradedAt = new Date(alpaca.tradedAt);
    const asOf = nyDateOf(tradedAt);
    if (asOf >= freshSince && (!closedOn || tradedAfterCloseOn(tradedAt, closedOn))) {
      return { price: alpaca.price, source: "alpaca_iex", asOf };
    }
    console.warn(`[followed-price] ${ticker}: Alpaca trade ${alpaca.tradedAt}, outside the window; falling back`);
  }

  // A daily bar is a completed session. For a closed-day window it must be that day's bar.
  const bar = await getLatestDailyBar(ticker);
  const barInWindow = closedOn ? bar?.barDate === closedOn : bar && bar.barDate >= freshSince;
  if (bar && bar.close > 0 && barInWindow) {
    console.warn(`[followed-price] ${ticker}: using daily_bars close from ${bar.barDate}`);
    return { price: bar.close, source: "daily_bars", asOf: bar.barDate };
  }

  console.warn(`[followed-price] ${ticker}: no price in the window (since ${freshSince}${closedOn ? `, closed ${closedOn}` : ""})`);
  return null;
}
