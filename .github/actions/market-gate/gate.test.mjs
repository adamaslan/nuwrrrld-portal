import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nyClock, settleSession, calendarDecision, completedSession, paperDecision, policyMatches, priceCoverage } from './gate.mjs';
const clock = value => nyClock(new Date(value));
const regular = [{ date: '2026-10-09', open: '09:30', close: '16:00' }];
function paper(time, overrides = {}, body = regular) {
  const c = clock(time);
  const eventTime = overrides.eventTime || time;
  const intended = settleSession(overrides.cron, eventTime) || c;
  return paperDecision({ clock: c, calendar: { ...calendarDecision(body, intended), latest_completed_session: completedSession(body, c) }, slot: 'preopen', eventTime, ...overrides });
}
test('three ET calendar days late is skipped, including Monday after Friday', () => {
  const result = paper('2026-10-12T13:00:00Z', { cron: '30 16 * * 1-5', eventTime: '2026-10-09T20:30:00Z' });
  assert.equal(result.is_trading_day, 'false');
  assert.match(result.reason, /more than 2 ET calendar days/);
  assert.equal(paper('2026-10-11T23:59:00Z', { cron: '30 16 * * 1-5', eventTime: '2026-10-09T20:30:00Z' }).is_trading_day, 'true');
});
test('holiday-adjacent settle within two days requires the latest completed session', () => {
  const wednesday = { date: '2026-11-25', open: '09:30', close: '16:00' };
  const friday = { date: '2026-11-27', open: '09:30', close: '13:00' };
  const options = { cron: '30 16 * * 1-5', eventTime: '2026-11-25T21:30:00Z' };
  // Thanksgiving has no row; Wednesday remains the latest until Friday closes.
  assert.equal(paper('2026-11-27T17:59:00Z', options, [wednesday, friday]).is_trading_day, 'true');
  const closed = paper('2026-11-27T18:00:00Z', options, [wednesday, friday]);
  assert.equal(closed.is_trading_day, 'false');
  assert.match(closed.reason, /not the most recent completed/);
  assert.equal(paper('2026-11-28T14:00:00Z', options, [wednesday, friday]).is_trading_day, 'false');
});
test('late settle fails closed when the completed-session evidence is unavailable', () => {
  const result = paperDecision({ clock: clock('2026-10-10T14:00:00Z'), calendar: calendarDecision(regular, clock('2026-10-09T21:00:00Z')), cron: '30 16 * * 1-5', eventTime: '2026-10-09T20:30:00Z' });
  assert.equal(result.is_trading_day, 'false');
  assert.match(result.reason, /calendar unavailable/);
});
test('ET Friday survives UTC Saturday, with a late mark-only settle', () => {
  const c = clock('2026-10-10T01:00:00Z');
  assert.equal(c.date, '2026-10-09');
  assert.equal(c.weekday, 'Fri');
  assert.equal(paper('2026-10-10T01:00:00Z', { cron: '30 16 * * 1-5' }).is_trading_day, 'true');
  assert.equal(paper('2026-10-10T04:01:00Z', { cron: '30 16 * * 1-5' }).is_trading_day, 'true');
  assert.equal(paper('2026-10-10T04:01:00Z', { cron: '30 16 * * 1-5' }).late, 'true');
  assert.equal(paper('2026-10-10T04:01:00Z', { slot: 'settle' }).is_trading_day, 'false');
});
test('intended settle date remains fixed across rechecks and refuses non-sessions', () => {
  const eventTime = '2026-10-10T04:01:00Z';
  assert.equal(settleSession('30 16 * * 1-5', eventTime).date, '2026-10-09');
  assert.equal(paper('2026-10-10T21:00:00Z', { cron: '30 16 * * 1-5', eventTime }).is_trading_day, 'true');
  for (const body of [[], null, [{ ...regular[0], close: 'bad' }]]) {
    assert.equal(paper(eventTime, { cron: '30 16 * * 1-5' }, body).is_trading_day, 'false');
  }
  assert.equal(paper('2026-10-11T04:01:00Z', { cron: '30 16 * * 1-5' }, [{ date: '2026-10-10', open: '09:30', close: '16:00' }]).is_trading_day, 'false');
  assert.equal(paper(eventTime, { cron: '30 21 * * 1-5' }).is_trading_day, 'false');
  const winter = [{ date: '2026-12-04', open: '09:30', close: '16:00' }];
  assert.equal(paper('2026-12-05T05:01:00Z', { cron: '30 16 * * 1-5' }, winter).is_trading_day, 'true');
  // A queued trading slot does not gain the settle exception.
  assert.equal(paper(eventTime, { cron: '0 9 * * 1-5' }).is_trading_day, 'false');
});
test('holiday, outage, malformed session and weekend fail closed', () => {
  const c = clock('2026-10-09T13:00:00Z');
  for (const body of [undefined, {}, [{ ...regular[0], close: 'bad' }], [{ ...regular[0], open: '17:00' }]]) assert.equal(calendarDecision(body,c).is_trading_day,'false');
  assert.equal(calendarDecision([],c).is_trading_day,'false');
  assert.equal(calendarDecision([{date:'2026-10-10',open:'09:30',close:'16:00'}], clock('2026-10-10T14:00:00Z')).is_trading_day,'false');
});
test('preopen refuses early starts and anything after the open', () => {
  for (const time of ['2026-10-09T12:59:00Z','2026-10-09T13:31:00Z','2026-10-09T21:37:00Z']) assert.equal(paper(time).is_trading_day,'false');
  for (const time of ['2026-10-09T13:00:00Z','2026-10-09T13:29:00Z']) assert.equal(paper(time).is_trading_day,'true');
});
test('a late midday start still trades, is marked late, and stops when preclose begins', () => {
  // 14:10 ET, well past the 12:30 nominal start.
  assert.equal(paper('2026-10-09T18:10:00Z', { slot: 'midday' }).is_trading_day, 'true');
  assert.equal(paper('2026-10-09T18:10:00Z', { slot: 'midday' }).late, 'true');
  assert.equal(paper('2026-10-09T19:44:00Z', { slot: 'midday' }).is_trading_day, 'true');
  assert.equal(paper('2026-10-09T19:45:00Z', { slot: 'midday' }).is_trading_day, 'false');
});
test('a late scheduled run still refuses closed days and sessions', () => {
  assert.equal(paper('2026-10-10T18:10:00Z', { slot: 'midday' }).is_trading_day, 'false');
  assert.equal(paper('2026-10-09T20:05:00Z', { slot: 'preclose' }).is_trading_day, 'false');
});
test('midday/preclose respect real session and early close', () => {
  assert.equal(paper('2026-10-09T16:30:00Z',{slot:'midday'}).is_trading_day,'true');
  assert.equal(paper('2026-10-09T19:45:00Z',{slot:'preclose'}).is_trading_day,'true');
  assert.equal(paper('2026-10-09T20:00:00Z',{slot:'preclose'}).is_trading_day,'false');
  assert.equal(paper('2026-10-09T19:45:00Z',{slot:'preclose'},[{...regular[0],close:'13:00'}]).is_trading_day,'false');
  assert.equal(calendarDecision(regular,clock('2026-10-09T20:00:00Z')).session_open,'false');
});
test('local crons identify every slot in both DST and winter', () => {
  for (const [date, offset] of [['2026-10-09', '-04:00'], ['2026-12-04', '-05:00']]) {
    const body = [{ date, open: '09:30', close: '16:00' }];
    for (const [time, cron, slot] of [
      ['09:07', '7 9 * * 1-5', 'preopen'], ['12:31', '31 12 * * 1-5', 'midday'],
      ['15:47', '47 15 * * 1-5', 'preclose'], ['16:30', '30 16 * * 1-5', 'settle'],
    ]) {
      const result = paper(`${date}T${time}:00${offset}`, { cron }, body);
      assert.equal(result.slot, slot);
      assert.equal(result.is_trading_day, 'true');
    }
    for (const cron of ['0 9 * * 1-5', '0 13 * * 1-5', '45 15 * * 1-5', '30 21 * * 1-5']) {
      assert.equal(paper(`${date}T09:00:00${offset}`, { cron, force: true }, body).is_trading_day, 'false');
    }
  }
});
test('settle local-date resolution handles DST changes and invalid event times', () => {
  assert.equal(settleSession('30 16 * * 1-5', '2026-11-01T21:29:00Z').date, '2026-10-31');
  assert.equal(settleSession('30 16 * * 1-5', '2026-11-01T21:30:00Z').date, '2026-11-01');
  assert.equal(settleSession('30 16 * * 1-5', '2026-03-08T20:29:00Z').date, '2026-03-07');
  assert.equal(settleSession('30 16 * * 1-5', '2026-03-08T20:30:00Z').date, '2026-03-08');
  assert.equal(settleSession('30 16 * * 1-5', 'invalid'), null);
  assert.equal(settleSession('', '2026-10-09T20:30:00Z'), null);
});
test('manual force overrides timing/calendar only with a valid slot', () => {
  assert.equal(paper('2026-10-09T21:00:00Z',{force:true},[]).is_trading_day,'true');
  assert.equal(paper('2026-10-09T21:00:00Z',{force:true,cron:'0 9 * * 1-5'}).is_trading_day,'false');
  assert.equal(paper('2026-10-09T21:00:00Z',{force:true,slot:'bad'}).is_trading_day,'false');
  // 08:40 ET is before the first slot, so an empty slot cannot resolve.
  assert.equal(paper('2026-10-09T12:40:00Z',{slot:''}).is_trading_day,'false');
  assert.equal(paper('2026-10-09T20:29:00Z',{slot:'settle'}).is_trading_day,'false');
});
test('refresh coverage must be present and at least 95%', () => {
  for(const log of ['', 'watchlist=100 priced=94 missing=6 source=alpaca feed=iex','watchlist=0 priced=0 missing=0 source=alpaca feed=iex']) assert.equal(priceCoverage(log),false);
  assert.equal(priceCoverage('watchlist=100 priced=95 missing=5 source=alpaca feed=iex\nPOST -> HTTP 200'),true);
});
test('policy comparison allows different SHAs but rejects different or missing policies', () => {
  assert.equal(policyMatches({sha:'previous-ready',policyVersion:'v4'},'v4'),true);
  assert.equal(policyMatches({policyVersion:'v3'},'v4'),false);
  assert.equal(policyMatches({},undefined),false);
});
test('paper workflow connects safety checks, rechecks and bounded runtime', () => {
  const s=readFileSync(new URL('../../workflows/paper-portfolios.yml',import.meta.url),'utf8');
  assert.deepEqual([...s.matchAll(/- cron: '([^']+)'\n      timezone: America\/New_York/g)].map(match => match[1]), ['7 9 * * 1-5', '17 9 * * 1-5', '27 9 * * 1-5', '31 12 * * 1-5', '41 12 * * 1-5', '51 12 * * 1-5', '47 15 * * 1-5', '52 15 * * 1-5', '57 15 * * 1-5', '30 16 * * 1-5']);
  assert.equal((s.match(/- cron:/g) || []).length, 10);
  assert.doesNotMatch(s,/continue-on-error|github\.sha|node-version: 20/);
  assert.match(s,/RECHECK_ALLOWED: \$\{\{ steps\.recheck\.outputs\.is_trading_day \}\}/);
  assert.match(s,/date: \$\{\{ steps\.session\.outputs\.session_date \}\}/);
  assert.match(s,/EVENT_TIME: \$\{\{ needs\.gate\.outputs\.event_time \}\}/);
  assert.equal((s.match(/CALENDAR_LATEST_COMPLETED_SESSION:/g) || []).length, 2);
  assert.match(s, /trade_date=\$\{SESSION_DATE\}/);
  assert.match(s, /group: paper-portfolios\n  cancel-in-progress: false/);
  assert.match(s,/priceCoverage\(readFileSync/);
  assert.match(s,/policyMatches\(JSON.parse/);
  assert.match(s,/node scripts\/push-alpaca-live-prices\.mjs[^\n]*\|\|/);
  assert.equal((s.match(/    runs-on:/g)||[]).length,(s.match(/^    timeout-minutes:/gm)||[]).length);
});
