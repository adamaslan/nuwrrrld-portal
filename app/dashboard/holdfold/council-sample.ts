import { cache } from "react";
import sql from "@/lib/db";
import { getCard } from "@/lib/ticker-cards-db";

export interface CouncilSample {
  ticker: string;
  fundName: string;
  simulatedCapitalUsd: number;
  shortTerm: { answer: string };
  longTerm: { answer: string };
  generatedAt: string;
  source: "precomputed" | "stored-card";
}

/** Read an off-request artifact; never generate AI or write on a public read. */
export const getCouncilSample = cache(async (): Promise<CouncilSample | null> => {
  try {
    const rows = await sql`
      SELECT payload, generated_at FROM precomputed_ai
      WHERE kind = 'council_sample' AND subject = 'MOO'
        AND generated_at > now() - interval '6 hours'
        AND (expires_at IS NULL OR expires_at > now()) LIMIT 1
    `;
    const payload = rows[0]?.payload as Partial<CouncilSample> | undefined;
    if (payload?.ticker === "MOO" && typeof payload.shortTerm?.answer === "string" &&
        typeof payload.longTerm?.answer === "string") {
      return { ticker: "MOO", fundName: "VanEck Agribusiness ETF", simulatedCapitalUsd: 10_000,
        shortTerm: payload.shortTerm, longTerm: payload.longTerm,
        generatedAt: String(rows[0].generated_at), source: "precomputed" };
    }
  } catch { /* An absent artifact can still use the stored signal cards. */ }
  const cards = await Promise.all([getCard("MOO", "t1"), getCard("MOO", "t2")]);
  const usable = cards.filter(card => card && card.isFinal !== false && card.dataQuality >= 0.8 &&
    card.missingFields.length === 0 && Number.isFinite(Date.parse(card.barDate)) &&
    Date.parse(card.barDate) <= Date.now() &&
    Date.now() - Date.parse(card.barDate) <= 7 * 24 * 60 * 60 * 1000);
  if (usable.length !== 2) return null;
  const answer = (card: NonNullable<typeof cards[number]>) =>
    `Stored signal overview (not an AI council deliberation), bars dated ${card.barDate}: ` +
    `${card.action}, score ${card.score}. RSI ${card.tokens.rsi}; MACD ${card.tokens.macd}; ` +
    `trend ${card.tokens.adx}. This signal alone does not establish future returns.`;
  return { ticker: "MOO", fundName: "VanEck Agribusiness ETF", simulatedCapitalUsd: 10_000,
    shortTerm: { answer: answer(cards[0]!) }, longTerm: { answer: answer(cards[1]!) },
    generatedAt: cards.map(card => card!.computedAt).sort()[0], source: "stored-card" };
});
