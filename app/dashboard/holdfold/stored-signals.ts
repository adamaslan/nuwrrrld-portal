import { cache } from "react";
import { bipolarCards } from "@/lib/ticker-cards-db";
import { fetchTickerEntry } from "@/lib/shared/signal-lookup";
import { mapSignalsToHoldFold, type HoldFoldPayload, type HoldFoldVerdict } from "@/lib/shared/holdfold-map";

export const SIGNALS_PER_SIDE = 24;

/** Bounded, balanced stored-card feed. Tokens are regimes, never numeric quotes. */
export const getStoredSignals = cache(async function getStoredSignals() {
  const cards = await bipolarCards("t1", SIGNALS_PER_SIDE, "stock");
  const symbols: Record<string, Record<string, unknown>> = {};
  for (const card of cards) {
    const tokens = Object.entries(card.tokens).filter(([key]) => key !== "horizon");
    symbols[card.ticker] = {
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

export async function getTickerVerdict(ticker: string): Promise<HoldFoldVerdict | null> {
  const symbol = ticker.trim().toUpperCase();
  const entry = await fetchTickerEntry(symbol);
  return entry ? mapAvailableVerdict(symbol, entry) : null;
}
