import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function nyClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset',
  }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday,
    minute: Number(parts.hour) * 60 + Number(parts.minute), offset: parts.timeZoneName };
}
const minutes = time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time ?? '') ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : NaN;

export function calendarDecision(body, clock) {
  const closed = { is_trading_day: 'false', open: '', close: '', session_open: 'false', source: 'unavailable' };
  if (!Array.isArray(body)) return closed;
  const session = body.find(row => row.date === clock.date);
  if (!session || ['Sat', 'Sun'].includes(clock.weekday)) return { ...closed, source: 'alpaca' };
  const open = minutes(session.open), close = minutes(session.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open || close > 1440) return closed;
  return { is_trading_day: 'true', open: session.open, close: session.close,
    session_open: String(clock.minute >= open && clock.minute < close), source: 'alpaca' };
}

export function paperDecision({ clock, calendar, cron = '', slot = '', force = false }) {
  const starts = { preopen: 540, midday: 750, preclose: 945, settle: 990 };
  const crons = clock.offset === 'GMT-4'
    ? ['0 13 * * 1-5', '30 16 * * 1-5', '45 19 * * 1-5', '30 20 * * 1-5']
    : ['0 14 * * 1-5', '30 17 * * 1-5', '45 20 * * 1-5', '30 21 * * 1-5'];
  if (cron) slot = Object.keys(starts)[crons.indexOf(cron)] ?? '';
  if (!slot && !cron) slot = Object.keys(starts).find(s => clock.minute >= starts[s] && (s === 'settle' || clock.minute <= starts[s] + 15)) ?? '';
  const skip = reason => ({ is_trading_day: 'false', slot, late: 'false', reason });
  if (!(slot in starts)) return skip('no slot or off-season cron');
  // A scheduled event can never opt into a manual override.
  force = force && !cron;
  if (!force && (['Sat', 'Sun'].includes(clock.weekday) || calendar.is_trading_day !== 'true')) return skip('closed day or unavailable calendar');
  const late = clock.minute < starts[slot] || clock.minute > starts[slot] + 15;
  if (!force && slot !== 'settle' && late) return skip('outside the 15-minute slot window');
  if (!force && slot === 'preopen' && clock.minute >= minutes(calendar.open)) return skip('session already opened');
  if (!force && ['midday', 'preclose'].includes(slot) && !(clock.minute >= minutes(calendar.open) && clock.minute < minutes(calendar.close))) return skip('session is closed');
  if (!force && slot === 'settle' && clock.minute < Math.max(starts.settle, minutes(calendar.close))) return skip('settle before close');
  return { is_trading_day: 'true', slot, late: String(late), reason: force ? 'manual force' : 'eligible' };
}

export function priceCoverage(log, floor = 0.95) {
  const match = log.match(/^watchlist=(\d+) priced=(\d+) missing=(\d+) source=alpaca feed=iex$/m);
  return Boolean(match && Number(match[1]) > 0 && Number(match[2]) <= Number(match[1]) && Number(match[3]) === Number(match[1]) - Number(match[2]) && Number(match[2]) / Number(match[1]) >= floor);
}
export function policyMatches(body, expected) {
  return typeof expected === 'string' && expected.length > 0 && body?.policyVersion === expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const clock = nyClock();
  let result;
  if (process.argv[2] === 'calendar') {
    let body;
    try {
      const url = new URL('https://paper-api.alpaca.markets/v2/calendar');
      url.searchParams.set('start', process.env.IN_DATE || clock.date);
      url.searchParams.set('end', process.env.IN_DATE || clock.date);
      const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': process.env.APCA_KEY || '', 'APCA-API-SECRET-KEY': process.env.APCA_SECRET || '' }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) body = await res.json();
    } catch { /* Missing calendar data fails closed; never log request credentials. */ }
    const date = process.env.IN_DATE || clock.date;
    const sessionClock = /^\d{4}-\d{2}-\d{2}$/.test(date) ? nyClock(new Date(`${date}T12:00:00-05:00`)) : clock;
    result = calendarDecision(body, { ...sessionClock, date, minute: date === clock.date ? clock.minute : -1 });
  } else {
    result = paperDecision({ clock, calendar: { is_trading_day: process.env.CALENDAR_DAY, open: process.env.CALENDAR_OPEN, close: process.env.CALENDAR_CLOSE }, cron: process.env.FIRED_CRON, slot: process.env.SLOT, force: process.env.FORCE === 'true' });
  }
  for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Market gate (${clock.date} ET): ${result.reason || result.source}; allowed=${result.is_trading_day}\n`);
}
