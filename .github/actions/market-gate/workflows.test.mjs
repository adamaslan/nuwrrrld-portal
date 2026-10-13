import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = (name) => readFileSync(new URL(`../../workflows/${name}.yml`, import.meta.url), 'utf8');
const track = workflow('track-followed-tickers');
function runTrack(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'track-gate-'));
  const output = join(dir, 'output');
  writeFileSync(join(dir, 'date'), '#!/bin/bash\ncase "$1" in +%u) echo "$TEST_DAY";; +%z) echo "$TEST_OFFSET";; +%H:%M) echo "$TEST_TIME";; *) exit 1;; esac\n', { mode: 0o755 });
  const start = track.indexOf('          set -euo pipefail', track.indexOf('- id: check'));
  const end = track.indexOf('\n  # ── Track', start);
  const script = track.slice(start, end).split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const result = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, TEST_DAY: '5', TEST_OFFSET: '-0400', TEST_TIME: '21:35', EVENT_NAME: 'schedule', FIRED_CRON: '30 20 * * 1-5', SKIP_MARKET_CHECK: 'false', CALENDAR_TRADING_DAY: 'true', SESSION_CLOSE: '16:00', ...overrides }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, 'utf8').trim();
}
test('delayed Friday EDT fire is accepted after UTC midnight', () => assert.equal(runTrack(), 'is_trading_day=true'));
test('off-season EST fire is rejected even after close', () => assert.equal(runTrack({ FIRED_CRON: '30 21 * * 1-5' }), 'is_trading_day=false'));
test('winter validates the EST entry', () => assert.equal(runTrack({ TEST_OFFSET: '-0500', FIRED_CRON: '30 21 * * 1-5' }), 'is_trading_day=true'));
test('weekends and unconfirmed calendar fail closed', () => {
  assert.equal(runTrack({ TEST_DAY: '6' }), 'is_trading_day=false');
  assert.equal(runTrack({ CALENDAR_TRADING_DAY: '' }), 'is_trading_day=false');
});
test('post-close gate uses the actual early close', () => {
  assert.equal(runTrack({ TEST_TIME: '13:01', SESSION_CLOSE: '13:00' }), 'is_trading_day=true');
  assert.equal(runTrack({ TEST_TIME: '12:59', SESSION_CLOSE: '13:00' }), 'is_trading_day=false');
});
test('manual bypass is explicit and cannot bypass a scheduled event', () => {
  assert.equal(runTrack({ EVENT_NAME: 'workflow_dispatch', TEST_DAY: '6', SKIP_MARKET_CHECK: 'true' }), 'is_trading_day=true');
  assert.equal(runTrack({ TEST_DAY: '6', SKIP_MARKET_CHECK: 'true' }), 'is_trading_day=false');
  assert.equal(runTrack({ EVENT_NAME: 'workflow_dispatch', TEST_TIME: '12:00' }), 'is_trading_day=false');
});
test('afternoon remains dispatch-only with ET weekday and bounded jobs', () => {
  const afternoon = workflow('afternoon-pipeline');
  assert.doesNotMatch(afternoon, /^  schedule:/m);
  assert.match(afternoon, /^  workflow_dispatch:/m);
  assert.match(afternoon, /DAY=\$\(TZ=America\/New_York date \+%u\)/);
  for (const name of ['afternoon-pipeline', 'track-followed-tickers', 'signal-freshness-check']) {
    const contents = workflow(name);
    assert.equal((contents.match(/    runs-on:/g) || []).length, (contents.match(/    timeout-minutes:/g) || []).length);
  }
});
test('freshness retains backup cron but gates API call on NY weekday/calendar without stale-hour skip', () => {
  const freshness = workflow('signal-freshness-check');
  assert.match(freshness, /cron: '0 13 \* \* 1-5'/);
  assert.match(freshness, /DAY=\$\(TZ=America\/New_York date \+%u\)/);
  assert.match(freshness, /\$DAY" -lt 6 && "\$CALENDAR_TRADING_DAY" == "true"/);
  assert.match(freshness, /if: steps\.market\.outputs\.is_trading_day == 'true'/);
  assert.doesNotMatch(freshness, /NY_HOUR|NY_TIME/);
  assert.match(freshness, /node-version: '22'/);
});

function runWeekdayGate(name, stepId, overrides = {}) {
  const contents = workflow(name);
  const marker = contents.indexOf(`- id: ${stepId}`);
  const start = contents.indexOf('        run: |\n', marker) + '        run: |\n'.length;
  const lines = contents.slice(start).split('\n');
  const scriptLines = [];
  for (const line of lines) {
    if (line && !line.startsWith('          ')) break;
    scriptLines.push(line.replace(/^          /, ''));
  }
  const script = scriptLines.join('\n')
    .replaceAll('${{ steps.calendar.outputs.is_trading_day }}', '$CALENDAR_TRADING_DAY')
    .replaceAll('${{ inputs.skip_market_check }}', '$SKIP_MARKET_CHECK');
  const dir = mkdtempSync(join(tmpdir(), 'weekday-gate-'));
  const output = join(dir, 'output');
  // Reject a UTC/default-zone date call: the weekday must come from New York.
  writeFileSync(join(dir, 'date'), '#!/bin/bash\n[[ "$TZ" == "America/New_York" ]] || exit 1\ncase "$1" in +%u) echo "$TEST_DAY";; +%H) echo "$TEST_HOUR";; *) exit 1;; esac\n', { mode: 0o755 });
  const result = spawnSync('bash', ['-e', '-c', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, TEST_DAY: '5', TEST_HOUR: '15', CALENDAR_TRADING_DAY: 'true', SKIP_MARKET_CHECK: 'false', ...overrides },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, 'utf8').trim();
}

test('freshness executes on confirmed ET weekdays and skips weekends/unknown calendar', () => {
  const run = (overrides) => runWeekdayGate('signal-freshness-check', 'market', overrides);
  assert.equal(run({ TEST_DAY: '5', TEST_HOUR: '23' }), 'is_trading_day=true');
  assert.equal(run({ TEST_DAY: '1', TEST_HOUR: '19' }), 'is_trading_day=true');
  assert.equal(run({ TEST_DAY: '6' }), 'is_trading_day=false');
  assert.equal(run({ TEST_DAY: '7' }), 'is_trading_day=false');
  assert.equal(run({ CALENDAR_TRADING_DAY: 'false' }), 'is_trading_day=false');
  assert.equal(run({ CALENDAR_TRADING_DAY: '' }), 'is_trading_day=false');
});

test('afternoon shell enforces ET weekday/calendar/preclose hour and explicit hour bypass', () => {
  const run = (overrides) => runWeekdayGate('afternoon-pipeline', 'check', overrides);
  assert.equal(run({}), 'is_trading_day=true');
  assert.equal(run({ TEST_DAY: '6' }), 'is_trading_day=false');
  assert.equal(run({ TEST_DAY: '7' }), 'is_trading_day=false');
  assert.equal(run({ CALENDAR_TRADING_DAY: 'false' }), 'is_trading_day=false');
  assert.equal(run({ CALENDAR_TRADING_DAY: '' }), 'is_trading_day=false');
  assert.equal(run({ TEST_HOUR: '14' }), 'is_trading_day=false');
  assert.equal(run({ TEST_HOUR: '16' }), 'is_trading_day=false');
  assert.equal(run({ TEST_HOUR: '14', SKIP_MARKET_CHECK: 'true' }), 'is_trading_day=true');
});
