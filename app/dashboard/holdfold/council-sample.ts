import { cache } from "react";
import sql from "@/lib/db";
import { getCard } from "@/lib/ticker-cards-db";
import { savePrecomputed } from "@/lib/precomputed-ai-db";

const SAMPLE_TTL_MS = 26 * 60 * 60 * 1000;

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
        AND generated_at > now() - interval '26 hours'
        AND (expires_at IS NULL OR expires_at > now()) LIMIT 1
    `;
    const payload = rows[0]?.payload as Partial<CouncilSample> | undefined;
    const generatedAt = rows[0]?.generated_at;
    const generatedTime = new Date(generatedAt).getTime();
    if (payload?.ticker === "MOO" && payload.shortTerm?.answer?.trim() &&
        payload.longTerm?.answer?.trim() && Number.isFinite(generatedTime) &&
        generatedTime <= Date.now() && Date.now() - generatedTime <= SAMPLE_TTL_MS) {
      return { ticker: "MOO", fundName: "VanEck Agribusiness ETF", simulatedCapitalUsd: 10_000,
        shortTerm: payload.shortTerm, longTerm: payload.longTerm,
        generatedAt: new Date(generatedTime).toISOString(), source: "precomputed" };
    }
  } catch { /* An absent artifact can still use the stored signal cards. */ }
  return loadStoredCouncilSample();
});

async function loadStoredCouncilSample(): Promise<CouncilSample | null> {
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
}

/** Persist a dated, card-grounded sample during the nightly precompute run. */
export async function refreshCouncilSample(): Promise<boolean> {
  const sample = await loadStoredCouncilSample();
  if (!sample) return false;
  return savePrecomputed(
    "council_sample", "MOO", sample, null, new Date(Date.now() + SAMPLE_TTL_MS),
  );
}
