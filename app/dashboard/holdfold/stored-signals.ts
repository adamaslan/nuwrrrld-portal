import { cache } from "react";
import { bipolarCards, getCard, type StoredCard } from "@/lib/ticker-cards-db";
import { fetchTickerEntry } from "@/lib/shared/signal-lookup";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { mapSignalsToHoldFold, type HoldFoldPayload, type HoldFoldVerdict } from "@/lib/shared/holdfold-map";

export const SIGNALS_PER_SIDE = 24;

/** One stored card in the `/signals` entry shape `mapAvailableVerdict` reads.
 *  Tokens are regimes, never numeric quotes. Shared by the index feed and the
 *  per-ticker fallback so both render the same card the same way. */
function cardToEntry(card: StoredCard): Record<string, unknown> {
  const tokens = Object.entries(card.tokens).filter(([key]) => key !== "horizon");
  return {
    symbol: card.ticker,
    ai_action: card.action,
    ai_confidence: card.tokens.confluence === "strong" ? "HIGH" : card.tokens.confluence === "moderate" ? "MEDIUM" : "LOW",
    ai_summary: `${card.action} · stored ${card.horizon} card`,
    ai_outlook: tokens.map(([key, value]) => `${key}: ${value}`).join(" · "),
    signals: tokens.map(([key, value]) => ({ signal: `${key}: ${value}`, detail: `Stored ${key} regime: ${value}`, category: key, strength: card.tokens.direction })),
    updated: card.computedAt,
    confluence_score: card.score,
    engine_version: card.scoreVersion,
  };
}

/** Bounded, balanced stored-card feed. Tokens are regimes, never numeric quotes. */
export const getStoredSignals = cache(async function getStoredSignals() {
  const cards = await bipolarCards("t1", SIGNALS_PER_SIDE, "stock");
  const symbols: Record<string, Record<string, unknown>> = {};
  for (const card of cards) {
    symbols[card.ticker] = cardToEntry(card);
  }
  return { symbols, updated: cards.map(card => card.computedAt).sort().at(-1) ?? "" };
});

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Keep unavailable raw measurements unavailable instead of decoding token buckets. */
export function mapAvailableVerdict(ticker: string, entry: Record<string, unknown>): HoldFoldVerdict {
  const verdict = mapSignalsToHoldFold({ symbols: { [ticker]: entry }, updated: entry.updated ?? "" })!.verdicts[0];
  const indicators = entry.indicators && typeof entry.indicators === "object" ? entry.indicators as Record<string, unknown> : {};
  return {
    ...verdict,
    confidence: finite(entry.confidence) ?? Number.NaN,
    rsi: finite(indicators.rsi), macd: finite(indicators.macd), adx: finite(indicators.adx),
    price: finite(entry.price) ?? Number.NaN,
    high52w: finite(entry["52w_high"]) ?? Number.NaN,
    low52w: finite(entry["52w_low"]) ?? Number.NaN,
    updatedAt: String(entry.updated ?? ""),
  };
}

export async function getStoredHoldFold(): Promise<HoldFoldPayload> {
  const raw = await getStoredSignals();
  const verdicts = Object.entries(raw.symbols).map(([ticker, entry]) => mapAvailableVerdict(ticker, entry));
  return { verdicts, total: verdicts.length, holdCount: verdicts.filter(v => v.verdict === "HOLD EM").length,
    foldCount: verdicts.filter(v => v.verdict === "FOLD EM").length,
    neutralCount: verdicts.filter(v => v.verdict === "NEUTRAL").length, updatedAt: raw.updated };
}

/** The eligibility filter `bipolarCards` applies, so the per-ticker fallback
 *  never renders a card the index would have filtered out. */
function isIndexEligible(card: StoredCard): boolean {
  return card.dataQuality >= 0.8 && card.missingFields.length === 0 && (card.isFinal ?? true);
}

export async function getTickerVerdict(ticker: string): Promise<HoldFoldVerdict | null> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;
  const entry = await fetchTickerEntry(symbol);
  if (entry) return mapAvailableVerdict(symbol, entry);
  // The Hold/Fold index and the dashboard's TOP MOVERS link to this page from
  // the stored-card feed, and the live/cache per-ticker lookup is a different
  // data plane — a card can exist without a fresh signal_cache entry. Fall
  // back to that stored card so index links never 404.
  const card = await getCard(symbol, "t1");
  return card && isIndexEligible(card) ? mapAvailableVerdict(symbol, cardToEntry(card)) : null;
}
