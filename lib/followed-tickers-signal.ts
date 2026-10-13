/**
 * followed-tickers-signal — today's signal direction for a followed pick.
 *
 * The cohort is selected from `ticker_cards`, so the daily observer reads the
 * same source. gcp3 `/signals` stays as a second source: it does not cover
 * most cohort tickers (it answers "not found"), which left `signal_dir` null
 * on 119 of 120 observation rows.
 */
import { getCard } from "@/lib/ticker-cards-db";
import { directionFromAction, directionFromCard, type PickDirection } from "@/lib/shared/followed-tickers-direction";
import { fetchTickerEntry } from "@/lib/shared/signal-lookup";

/** ticker_cards t1 first, gcp3 second; null only when neither has a fresh read. */
export async function liveDirectionFor(
  ticker: string,
  today: string,
): Promise<PickDirection | null> {
  const fromCard = directionFromCard(await getCard(ticker, "t1"), today);
  if (fromCard) return fromCard;
  const entry = await fetchTickerEntry(ticker);
  return directionFromAction(entry?.ai_action);
}
