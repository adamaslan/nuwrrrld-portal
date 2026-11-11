/** Return values are percentage points, never fractions or parsed headlines. */
export const RETURN_PERIODS = ['1d', '1m', '1y'] as const;
export type ReturnPeriod = typeof RETURN_PERIODS[number];
export type ReturnStatus = 'available' | 'missing' | 'stale' | 'invalid_basis' | 'invalid';
export interface PeriodReturn {
  value: number | null;
  status: ReturnStatus;
  start: string | null;
  end: string | null;
  basis: 'split-adjusted-close' | 'unknown';
}
export type SignalReturns = Record<ReturnPeriod, PeriodReturn>;
export const RETURN_LABELS: Record<ReturnPeriod, string> = {
  '1d': 'Last completed session', '1m': 'Trailing 30 calendar days', '1y': 'Trailing 365 calendar days',
};
function day(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
}
/** Legacy values remain inspectable but are not ranked without verified interval/basis metadata. */
export function adaptReturns(values: unknown, metadata: unknown, stale: boolean): SignalReturns {
  const source = values && typeof values === 'object' ? values as Record<string, unknown> : {};
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {};
  return Object.fromEntries(RETURN_PERIODS.map(period => {
    const value = source[period];
    const m = meta[period] && typeof meta[period] === 'object' ? meta[period] as Record<string, unknown> : {};
    const start = day(m.start) ? m.start : null;
    const end = day(m.end) ? m.end : null;
    const basis = m.price_basis === 'split-adjusted-close' ? 'split-adjusted-close' : 'unknown';
    const finite = typeof value === 'number' && Number.isFinite(value);
    const validInterval = !!start && !!end && start < end && Date.parse(end) <= Date.now();
    const status: ReturnStatus = value == null ? 'missing' : !finite || (finite && value < -100) ? 'invalid' : stale ? 'stale' : basis === 'unknown' || m.verified !== true || !validInterval ? 'invalid_basis' : 'available';
    return [period, { value: finite ? value : null, status, start, end, basis }];
  })) as SignalReturns;
}
