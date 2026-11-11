/**
 * signalFilters — shared search/filter/sort logic for signal lists.
 * Used by web SignalsClient and mobile DigestScreen so both surfaces
 * apply identical filtering semantics.
 */
import { RETURN_PERIODS, type ReturnPeriod } from "@/lib/shared/signalReturns";
import type { SignalPayload } from "@/lib/digest";

export type Direction = 'all' | 'bullish' | 'bearish' | 'neutral';
export type ReturnSort = `${ReturnPeriod}-${'gainers' | 'losers'}`;
export type SortKey = 'confidence' | 'ticker' | ReturnSort;

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

export function normalizeSort(value: unknown): SortKey {
  return value === 'ticker' || value === 'confidence' || RETURN_PERIODS.some(p => value === `${p}-gainers` || value === `${p}-losers`) ? value as SortKey : 'confidence';
}
export function returnRanking(signals: SignalPayload[], sort: SortKey) {
  const period = sort.split('-')[0] as ReturnPeriod;
  const usable = signals.filter(s => !s.isStale && s.returns?.[period]?.status === 'available');
  const intervals = new Set(usable.map(s => `${s.returns![period].start}/${s.returns![period].end}/${s.returns![period].basis}`));
  const mixed = intervals.size > 1;
  const flat = usable.filter(s => s.returns![period].value === 0).length;
  return {period, eligible: mixed ? 0 : usable.length-flat, flat, withheld: mixed ? signals.length : signals.length-usable.length, mixed, interval: intervals.size === 1 ? [...intervals][0] : null};
}
export function sortSignals(signals: SignalPayload[], requested: SortKey): SignalPayload[] {
  const sort = normalizeSort(requested);
  const tie = (a: SignalPayload,b: SignalPayload) => a.ticker.localeCompare(b.ticker) || a.id.localeCompare(b.id);
  if (sort !== 'confidence' && sort !== 'ticker') {
    const ranking = returnRanking(signals, sort);
    if (ranking.mixed) return [];
    const gainers = sort.endsWith('-gainers');
    const period = ranking.period;
    return signals.filter(s => !s.isStale && s.returns?.[period]?.status === 'available' && (gainers ? s.returns[period].value! > 0 : s.returns[period].value! < 0))
      .sort((a,b) => (gainers ? -1 : 1) * (a.returns![period].value! - b.returns![period].value!) || tie(a,b));
  }
  return [...signals].sort((a,b) => sort === 'ticker' ? tie(a,b) : (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0) || tie(a,b));
}
