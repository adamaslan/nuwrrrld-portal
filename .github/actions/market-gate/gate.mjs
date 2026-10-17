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
const calendarDays = (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

export function completedSession(body, clock) {
  if (!Array.isArray(body)) return '';
  const completed = body.filter(row => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row?.date ?? '') || row.date > clock.date) return false;
    const sessionClock = nyClock(new Date(`${row.date}T12:00:00-05:00`));
    const valid = calendarDecision([row], sessionClock).is_trading_day === 'true';
    return valid && (row.date < clock.date || clock.minute >= minutes(row.close));
  });
  return completed.map(row => row.date).sort().at(-1) || '';
}

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

// Resolve the latest daily occurrence, without rolling a weekend back to Friday.
// The workflow creation time stays fixed across queued jobs and re-runs.
export function settleSession(cron, eventTime) {
  if (cron !== '30 16 * * 1-5') return null;
  const fired = new Date(eventTime);
  if (!Number.isFinite(fired.getTime())) return null;
  const local = nyClock(fired);
  // Work in ET calendar dates, so crossing a DST boundary cannot shift the slot.
  const intended = new Date(`${local.date}T12:00:00Z`);
  if (local.minute < 990) intended.setUTCDate(intended.getUTCDate() - 1);
  return { ...nyClock(intended), minute: 990 };
}

export function paperDecision({ clock, calendar, cron = '', slot = '', force = false, eventTime }) {
  const starts = { preopen: 540, midday: 750, preclose: 945, settle: 990 };
  const intended = settleSession(cron, eventTime);
  const sessionClock = intended || clock;
  const crons = ['0 9 * * 1-5', '30 12 * * 1-5', '45 15 * * 1-5', '30 16 * * 1-5'];
  if (cron) slot = Object.keys(starts)[crons.indexOf(cron)] ?? '';
  if (!slot && !cron) slot = Object.keys(starts).find(s => clock.minute >= starts[s] && (s === 'settle' || clock.minute <= starts[s] + 15)) ?? '';
  const skip = reason => ({ is_trading_day: 'false', slot, late: 'false', reason });
  if (!(slot in starts)) return skip('no slot or unknown cron');
  // A scheduled event can never opt into a manual override.
  force = force && !cron;
  if (!force && (['Sat', 'Sun'].includes(sessionClock.weekday) || calendar.is_trading_day !== 'true')) return skip('closed day or unavailable calendar');
  const late = clock.date !== sessionClock.date || clock.minute < starts[slot] || clock.minute > starts[slot] + 15;
  if (!force && slot !== 'settle' && late) return skip('outside the 15-minute slot window');
  if (!force && slot === 'preopen' && clock.minute >= minutes(calendar.open)) return skip('session already opened');
  if (!force && ['midday', 'preclose'].includes(slot) && !(clock.minute >= minutes(calendar.open) && clock.minute < minutes(calendar.close))) return skip('session is closed');
  if (!force && slot === 'settle' && (clock.date < sessionClock.date || (clock.date === sessionClock.date && clock.minute < Math.max(starts.settle, minutes(calendar.close))))) return skip('settle before close');
  if (!force && slot === 'settle' && clock.date > sessionClock.date) {
    if (calendarDays(sessionClock.date, clock.date) > 2) return skip('settle more than 2 ET calendar days late');
    if (calendar.latest_completed_session !== sessionClock.date) return skip('intended settle is not the most recent completed trading session (or calendar unavailable)');
  }
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
  if (process.argv[2] === 'session') {
    result = { session_date: settleSession(process.env.FIRED_CRON, process.env.EVENT_TIME)?.date || clock.date };
  } else if (process.argv[2] === 'calendar') {
    let body;
    try {
      const url = new URL('https://paper-api.alpaca.markets/v2/calendar');
      url.searchParams.set('start', process.env.IN_DATE || clock.date);
      url.searchParams.set('end', clock.date);
      const res = await fetch(url, { headers: { 'APCA-API-KEY-ID': process.env.APCA_KEY || '', 'APCA-API-SECRET-KEY': process.env.APCA_SECRET || '' }, signal: AbortSignal.timeout(15_000) });
      if (res.ok) body = await res.json();
    } catch { /* Missing calendar data fails closed; never log request credentials. */ }
    const date = process.env.IN_DATE || clock.date;
    const sessionClock = /^\d{4}-\d{2}-\d{2}$/.test(date) ? nyClock(new Date(`${date}T12:00:00-05:00`)) : clock;
    result = { ...calendarDecision(body, { ...sessionClock, date, minute: date === clock.date ? clock.minute : -1 }),
      latest_completed_session: completedSession(body, clock) };
  } else {
    result = paperDecision({ clock, calendar: { is_trading_day: process.env.CALENDAR_DAY, open: process.env.CALENDAR_OPEN, close: process.env.CALENDAR_CLOSE, latest_completed_session: process.env.CALENDAR_LATEST_COMPLETED_SESSION }, cron: process.env.FIRED_CRON, eventTime: process.env.EVENT_TIME, slot: process.env.SLOT, force: process.env.FORCE === 'true' });
  }
  for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  const summary = result.session_date
    ? `Intended market session: ${result.session_date} ET`
    : `Market gate (${clock.date} ET): ${result.reason || result.source}; allowed=${result.is_trading_day}`;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
