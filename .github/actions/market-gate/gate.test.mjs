import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nyClock, calendarDecision, paperDecision, policyMatches, priceCoverage } from './gate.mjs';
const clock = value => nyClock(new Date(value));
const regular = [{ date: '2026-10-09', open: '09:30', close: '16:00' }];
function paper(time, overrides = {}, body = regular) {
  const c = clock(time);
  return paperDecision({ clock: c, calendar: calendarDecision(body, c), slot: 'preopen', ...overrides });
}
test('ET Friday survives UTC Saturday, with a late mark-only settle', () => {
  const c = clock('2026-10-10T01:00:00Z');
  assert.equal(c.date, '2026-10-09');
  assert.equal(c.weekday, 'Fri');
  assert.equal(paper('2026-10-10T01:00:00Z', { cron: '30 20 * * 1-5' }).is_trading_day, 'true');
  assert.equal(paper('2026-10-10T04:01:00Z', { slot: 'settle' }).is_trading_day, 'false');
});
test('holiday, outage, malformed session and weekend fail closed', () => {
  const c = clock('2026-10-09T13:00:00Z');
  for (const body of [undefined, {}, [{ ...regular[0], close: 'bad' }], [{ ...regular[0], open: '17:00' }]]) assert.equal(calendarDecision(body,c).is_trading_day,'false');
  assert.equal(calendarDecision([],c).is_trading_day,'false');
  assert.equal(calendarDecision([{date:'2026-10-10',open:'09:30',close:'16:00'}], clock('2026-10-10T14:00:00Z')).is_trading_day,'false');
});
test('15-minute trading window rejects both early and late starts', () => {
  for (const time of ['2026-10-09T12:59:00Z','2026-10-09T13:16:00Z','2026-10-09T21:37:00Z']) assert.equal(paper(time).is_trading_day,'false');
  for (const time of ['2026-10-09T13:00:00Z','2026-10-09T13:15:00Z']) assert.equal(paper(time).is_trading_day,'true');
});
test('midday/preclose respect real session and early close', () => {
  assert.equal(paper('2026-10-09T16:30:00Z',{slot:'midday'}).is_trading_day,'true');
  assert.equal(paper('2026-10-09T19:45:00Z',{slot:'preclose'}).is_trading_day,'true');
  assert.equal(paper('2026-10-09T20:00:00Z',{slot:'preclose'}).is_trading_day,'false');
  assert.equal(paper('2026-10-09T19:45:00Z',{slot:'preclose'},[{...regular[0],close:'13:00'}]).is_trading_day,'false');
  assert.equal(calendarDecision(regular,clock('2026-10-09T20:00:00Z')).session_open,'false');
});
test('seasonal cron identifies slot and ignores the other offset', () => {
  assert.equal(paper('2026-10-09T13:00:00Z',{cron:'0 14 * * 1-5'}).is_trading_day,'false');
  assert.equal(paper('2026-10-09T13:00:00Z',{cron:'0 13 * * 1-5'}).is_trading_day,'true');
  const c=clock('2026-12-04T14:00:00Z');
  const calendar=calendarDecision([{date:c.date,open:'09:30',close:'16:00'}],c);
  assert.equal(paperDecision({clock:c,calendar,cron:'0 14 * * 1-5'}).slot,'preopen');
  assert.equal(paperDecision({clock:c,calendar,cron:'0 13 * * 1-5'}).is_trading_day,'false');
});
test('manual force overrides timing/calendar only with a valid slot', () => {
  assert.equal(paper('2026-10-09T21:00:00Z',{force:true},[]).is_trading_day,'true');
  assert.equal(paper('2026-10-09T21:00:00Z',{force:true,cron:'0 13 * * 1-5'}).is_trading_day,'false');
  assert.equal(paper('2026-10-09T21:00:00Z',{force:true,slot:'bad'}).is_trading_day,'false');
  assert.equal(paper('2026-10-09T19:40:00Z',{slot:''}).is_trading_day,'false');
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
  assert.doesNotMatch(s,/continue-on-error|github\.sha|node-version: 20/);
  assert.match(s,/if: steps\.recheck\.outputs\.is_trading_day == 'true'/);
  assert.match(s,/priceCoverage\(readFileSync/);
  assert.match(s,/policyMatches\(JSON.parse/);
  assert.match(s,/node scripts\/push-alpaca-live-prices\.mjs[^\n]*\|\|/);
  assert.equal((s.match(/    runs-on:/g)||[]).length,(s.match(/^    timeout-minutes:/gm)||[]).length);
});
