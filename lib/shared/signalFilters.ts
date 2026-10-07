/**
 * signalFilters — shared search/filter/sort logic for signal lists.
 * Used by web SignalsClient and mobile DigestScreen so both surfaces
 * apply identical filtering semantics.
 */
import type { SignalPayload } from "@/lib/digest";

export type Direction = 'all' | 'bullish' | 'bearish' | 'neutral';
export type SortKey = 'confidence' | 'dayGain' | 'confluence' | 'ticker' | 'tickerDesc' | 'timeframe';

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'dayGain', label: 'Day gain (best first)' },
  { key: 'confluence', label: 'Confluence score (highest first)' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'ticker', label: 'Ticker A–Z' },
  { key: 'tickerDesc', label: 'Ticker Z–A' },
];

export function isSortKey(v: unknown): v is SortKey {
  return SORT_OPTIONS.some(o => o.key === v);
}

export const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function filterSignals(
  signals: SignalPayload[],
  search: string,
  direction: Direction,
): SignalPayload[] {
  let list = signals;
  if (direction !== 'all') list = list.filter(s => s.direction === direction);
  const q = search.trim().toLowerCase();
  if (q) list = list.filter(s => s.ticker.toLowerCase().includes(q) || s.title.toLowerCase().includes(q));
  return list;
}

/** Descending numeric compare that always sinks missing values to the bottom, whichever way it sorts. */
function byNumberDesc(a: number | undefined, b: number | undefined): number {
  const aMissing = a == null || Number.isNaN(a);
  const bMissing = b == null || Number.isNaN(b);
  if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
  return b - a;
}

function primaryCompare(a: SignalPayload, b: SignalPayload, sort: SortKey): number {
  switch (sort) {
    case 'confidence': return (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
    case 'dayGain': return byNumberDesc(a.dayChangePct, b.dayChangePct);
    case 'confluence': return byNumberDesc(a.score, b.score);
    case 'ticker': return a.ticker.localeCompare(b.ticker);
    case 'tickerDesc': return b.ticker.localeCompare(a.ticker);
    default: return 0;
  }
}

/** Stable sort; ties fall back to ticker A–Z so equal-valued rows never reshuffle between renders. */
export function sortSignals(signals: SignalPayload[], sort: SortKey): SignalPayload[] {
  return [...signals].sort((a, b) => primaryCompare(a, b, sort) || a.ticker.localeCompare(b.ticker));
}
