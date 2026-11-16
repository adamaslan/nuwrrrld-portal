import type { HoldFoldVerdict } from "@/lib/shared/holdfold-map";

interface IndexEntry { symbol?: string; price?: number; change_pct?: number }
export interface MarketOverview {
  brief?: { summary?: string; market_tone?: string; indices?: Record<string, IndexEntry> }
}


export function buildBriefPrompt(
  tier: string,
  market: MarketOverview | null,
  verdicts: HoldFoldVerdict[] | null,
): string {
  const hasMarket = market?.brief != null;
  const hasVerdicts = Array.isArray(verdicts) && verdicts.length > 0;

  // Only state what was actually fetched. Previously the prompt always emitted
  // placeholder lines ("Index data unavailable") *and* still ordered the model
  // to "cite specific indices, percentages, or verdicts" — so on an upstream
  // failure the model dutifully wrote four sentences citing the absence of
  // data. Omit the section instead, and scope the instructions to match.
  const lines: string[] = [`=== REAL MARKET DATA ===`];

  if (hasMarket) {
    const b = market!.brief!;
    if (b.market_tone) lines.push(`Market tone: ${b.market_tone}`);
    if (b.indices) {
      const indices = Object.entries(b.indices).slice(0, 4).map(([name, idx]) => {
        if (idx == null || typeof idx !== "object") return null;
        const chg = idx.change_pct != null ? `${idx.change_pct >= 0 ? "+" : ""}${idx.change_pct.toFixed(2)}%` : "";
        const price = idx.price != null ? idx.price.toLocaleString("en-US") : "n/a";
        return `${name} (${idx.symbol ?? name}): ${price} ${chg}`.trim();
      }).filter((s): s is string => s != null).join(", ");
      if (indices) lines.push(`Indices: ${indices}`);
    }
    if (b.summary) lines.push(`AI summary: ${b.summary}`);
  }

  if (hasVerdicts) {
    const topVerdicts = verdicts!
      .map(v => `${v.ticker}: ${v.verdict} (${v.confidenceLabel})`)
      .join("; ");
    lines.push(`Top Hold/Fold verdicts: ${topVerdicts}`);
  }

  const available = [hasMarket && "index/market data", hasVerdicts && "Hold/Fold verdicts"]
    .filter(Boolean).join(" and ");

  const formatPoints = [
    hasMarket && "Market overview",
    hasVerdicts ? "Standout verdict or signal" : hasMarket && "Standout index move",
    "Key risk to watch",
    "One actionable takeaway",
  ].filter((p): p is string => Boolean(p));

  lines.push(
    `User tier: ${tier}`,
    ``,
    `You are Nu AI, a financial information assistant for NuWrrrld Financial.`,
    `Write a personalized ${formatPoints.length}-sentence morning brief for this ${tier} user.`,
    `Ground every sentence in the EXACT data above — cite only the ${available} shown.`,
    `Never mention missing, unavailable, or unknown data; write only about what is given.`,
    `Format: ${formatPoints.map((p, i) => `${i + 1}) ${p}`).join(" ")}.`,
    `Do not give specific buy/sell price targets. This is informational only, not personalised financial advice.`,
  );

  return lines.join("\n");
}
