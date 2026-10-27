import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = (name) => readFileSync(new URL(`../../workflows/${name}.yml`, import.meta.url), 'utf8');
// Extract only a step's literal run block, without relying on job comments or shell markers.
function shellStep(contents, stepId) {
  const lines = contents.split(/\r?\n/);
  const ids = lines.flatMap((line, index) => {
    const match = line.match(/^( *)(- )?id: ['"]?([\w-]+)['"]?\s*(?:#.*)?$/);
    return match?.[3] === stepId ? [{ index, indent: match[1].length, first: Boolean(match[2]) }] : [];
  });
  assert.equal(ids.length, 1, `Expected exactly one step id: ${stepId}`);
  const id = ids[0];
  const indent = id.indent - (id.first ? 0 : 2);
  let start = id.index;
  while (start >= 0 && !lines[start].startsWith(`${' '.repeat(indent)}- `)) start--;
  assert.ok(start >= 0, `Missing sequence entry for step ${stepId}`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent) break;
    end++;
  }
  const step = lines.slice(start, end);
  const runs = step.flatMap((line, index) =>
    line.match(new RegExp(`^ {${indent + 2}}run: \\|[+-]?\\s*(?:#.*)?$`)) ? [index] : []);
  assert.equal(runs.length, 1, `Expected one literal run block for step ${stepId}`);
  const body = [];
  let bodyIndent;
  for (const line of step.slice(runs[0] + 1)) {
    if (!line.trim()) { body.push(''); continue; }
    const currentIndent = line.search(/\S/);
    if (currentIndent <= indent + 2) break;
    bodyIndent ??= currentIndent;
    assert.ok(currentIndent >= bodyIndent, `Invalid run indentation for step ${stepId}`);
    body.push(line.slice(bodyIndent));
  }
  assert.ok(body.some(line => line.trim()), `Empty run block for step ${stepId}`);
  return { script: body.join('\n'), metadata: step.slice(0, runs[0]).join('\n') };
}
test('shell extraction follows step boundaries and asserts missing or ambiguous blocks', () => {
  const contents = `steps:
  - name: Example
    id: 'check'
    run: |- # literal shell
      echo first
        echo nested

  - id: next
    run: |
      echo second
`;
  assert.equal(shellStep(contents, 'check').script.trimEnd(), 'echo first\n  echo nested');
  assert.throws(() => shellStep(contents, 'missing'), /Expected exactly one step id/);
  assert.throws(() => shellStep(contents.replace("id: 'check'", 'id: next'), 'next'), /Expected exactly one step id/);
  assert.throws(() => shellStep(contents.replace('run: |- # literal shell', 'uses: example/action'), 'check'), /Expected one literal run block/);
});
const track = workflow('track-followed-tickers');
function runTrack(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'track-gate-'));
  const output = join(dir, 'output');
  writeFileSync(join(dir, 'date'), '#!/bin/bash\ncase "$1" in +%u) echo "$TEST_DAY";; +%z) echo "$TEST_OFFSET";; +%H:%M) echo "$TEST_TIME";; *) exit 1;; esac\n', { mode: 0o755 });
  const { script } = shellStep(track, 'check');
  const result = spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, TEST_DAY: '5', TEST_OFFSET: '-0400', TEST_TIME: '21:35', EVENT_NAME: 'schedule', FIRED_CRON: '30 16 * * 1-5', SKIP_MARKET_CHECK: 'false', CALENDAR_TRADING_DAY: 'true', SESSION_CLOSE: '16:00', ...overrides }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, 'utf8').trim();
}
test('delayed Friday EDT fire is accepted after UTC midnight', () => assert.equal(runTrack(), 'is_trading_day=true'));
test('one New York schedule covers both daylight saving offsets', () => {
  assert.equal((track.match(/^    - cron:/gm) || []).length, 1);
  assert.match(track, /cron: '30 16 \* \* 1-5'\n      timezone: America\/New_York/);
  assert.equal(runTrack({ TEST_OFFSET: '-0500', TEST_TIME: '16:30' }), 'is_trading_day=true');
  assert.equal(runTrack({ TEST_OFFSET: '-0400', TEST_TIME: '16:30' }), 'is_trading_day=true');
});
test('retired UTC schedules are rejected even after close', () => {
  for (const cron of ['30 20 * * 1-5', '30 21 * * 1-5']) {
    assert.equal(runTrack({ FIRED_CRON: cron }), 'is_trading_day=false');
  }
});
test('weekends and unconfirmed calendar fail closed', () => {
  assert.equal(runTrack({ TEST_DAY: '6' }), 'is_trading_day=false');
  assert.equal(runTrack({ CALENDAR_TRADING_DAY: '' }), 'is_trading_day=false');
  assert.equal(runTrack({ SESSION_CLOSE: '' }), 'is_trading_day=false');
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

function runWeekdayGate(name, stepId, overrides = {}, details = false) {
  const contents = workflow(name);
  const script = shellStep(contents, stepId).script
    .replaceAll('${{ steps.calendar.outputs.is_trading_day }}', '$CALENDAR_TRADING_DAY')
    .replaceAll('${{ inputs.skip_market_check }}', '$SKIP_MARKET_CHECK');
  const dir = mkdtempSync(join(tmpdir(), 'weekday-gate-'));
  const output = join(dir, 'output');
  // Reject a UTC/default-zone date call: the weekday must come from New York.
  writeFileSync(join(dir, 'date'), '#!/bin/bash\n[[ "$TZ" == "America/New_York" ]] || exit 1\ncase "$1" in +%u) echo "$TEST_DAY";; +%H) echo "$TEST_HOUR";; *) exit 1;; esac\n', { mode: 0o755 });
  const result = spawnSync('bash', ['-e', '-c', script], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(dir, 'summary'), CALENDAR_SOURCE: 'alpaca', TEST_DAY: '5', TEST_HOUR: '15', CALENDAR_TRADING_DAY: 'true', SKIP_MARKET_CHECK: 'false', ...overrides },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return details ? { output: readFileSync(output, 'utf8').trim(), stdout: result.stdout, summary: readFileSync(join(dir, 'summary'), 'utf8') } : readFileSync(output, 'utf8').trim();
}

test('freshness outage emits an annotation and visible summary', () => {
  const result = runWeekdayGate('signal-freshness-check', 'market', { CALENDAR_TRADING_DAY: 'false', CALENDAR_SOURCE: 'unavailable' }, true);
  assert.equal(result.output, 'is_trading_day=false');
  assert.match(result.stdout, /::warning::Alpaca calendar unavailable/);
  assert.match(result.summary, /freshness check skipped; signal freshness was not verified/);
});

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


test('paper pre-POST refusal fails before any network request', () => {
  const contents = workflow('paper-portfolios');
  const step = shellStep(contents, 'run');
  const end = step.script.search(/^URL=/m);
  assert.ok(end > 0, 'Expected URL construction after the pre-POST refusal');
  const script = step.script.slice(0, end);
  const result = spawnSync('bash', ['-c', script], {
    env: { ...process.env, RECHECK_ALLOWED: 'false', RECHECK_REASON: 'outside the 30-minute slot window' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::Paper slot refused.*30-minute slot window.*No POST was sent/);
  assert.doesNotMatch(step.metadata, /if: steps\.recheck/);
});
