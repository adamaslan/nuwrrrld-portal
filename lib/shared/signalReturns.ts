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
const DAY_MS = 24 * 60 * 60 * 1000;
const PERIOD_DAYS: Record<ReturnPeriod, number> = {'1d': 1, '1m': 30, '1y': 365};
// A bounded calendar tolerance permits weekends/holidays. It does not certify
// exchange-session completeness or prove the source's adjustment basis.
const MAX_CALENDAR_GAP_DAYS = 7;
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
    const now = Date.now();
    const durationDays = start && end ? (Date.parse(end) - Date.parse(start)) / DAY_MS : NaN;
    const expectedDays = PERIOD_DAYS[period];
    const validInterval = !!start && !!end && Date.parse(end) <= now
      && durationDays >= expectedDays && durationDays <= expectedDays + MAX_CALENDAR_GAP_DAYS;
    // A newly regenerated signal must not launder an old return snapshot.
    const todayUtc = Math.floor(now / DAY_MS) * DAY_MS;
    const oldSnapshot = !!end && todayUtc - Date.parse(end) > MAX_CALENDAR_GAP_DAYS * DAY_MS;
    const status: ReturnStatus = value == null ? 'missing' : !finite || (finite && value < -100) ? 'invalid' : stale || oldSnapshot ? 'stale' : basis === 'unknown' || m.verified !== true || !validInterval ? 'invalid_basis' : 'available';
    return [period, { value: finite ? value : null, status, start, end, basis }];
  })) as SignalReturns;
}
