/**
 * signalFilters — shared search/filter/sort logic for signal lists.
 * Used by web SignalsClient and mobile DigestScreen so both surfaces
 * apply identical filtering semantics.
 */
import type { SignalPayload } from "@/lib/digest";

export type Direction = "all" | "bullish" | "bearish" | "neutral";
export type SortKey = "confidence" | "ticker" | "timeframe";

export const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function filterSignals(
  signals: SignalPayload[],
  search: string,
  direction: Direction,
): SignalPayload[] {
  let list = signals;
  if (direction !== "all") list = list.filter(s => s.direction === direction);
  const q = search.trim().toLowerCase();
  if (q) list = list.filter(s => s.ticker.toLowerCase().includes(q) || s.title.toLowerCase().includes(q));
  return list;
}

export function sortSignals(signals: SignalPayload[], sort: SortKey): SignalPayload[] {
  return [...signals].sort((a, b) => {
    if (sort === "confidence") return (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
    if (sort === "ticker") return a.ticker.localeCompare(b.ticker);
    return 0;
  });
}
