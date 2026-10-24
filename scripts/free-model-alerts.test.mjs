import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffChains, parseChain } from './free-model-chain.mjs';
import {
  alertDecision,
  checkChain,
  classifyProbe,
  deliverNotifications,
  findRegressions,
  formatAlertMessage,
  isFreePricing,
  mergeRegressionSignatures,
  carryForwardSignature,
  nextAlertedSignature,
  notificationTimeoutMs,
  probeModel,
  regressionSignature,
} from './free-model-health-check.mjs';

const SOURCE = `
export const SEAT_MODELS = { T1: 'x/y' } as const;
export const FREE_MODEL_CHAIN = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'google/gemma-4-26b-a4b-it:free',
] as const;
`;

test('parseChain returns the ids in order and ignores other arrays', () => {
  assert.deepEqual(parseChain(SOURCE), [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-26b-a4b-it:free',
  ]);
});

test('parseChain throws when the export is missing rather than reporting an empty chain', () => {
  assert.throws(() => parseChain('export const OTHER = [];'), /not found/);
});

test('parseChain throws on an empty array', () => {
  assert.throws(() => parseChain('export const FREE_MODEL_CHAIN = [] as const;'), /zero ids/);
});

test('diffChains reports added and removed ids and whether order changed', () => {
  const diff = diffChains(['a:free', 'b:free'], ['b:free', 'c:free']);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.added, ['c:free']);
  assert.deepEqual(diff.removed, ['a:free']);
});

test('diffChains reports a reorder as a change with no adds or removes', () => {
  const diff = diffChains(['a:free', 'b:free'], ['b:free', 'a:free']);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('diffChains reports no change for identical chains', () => {
  assert.equal(diffChains(['a:free'], ['a:free']).changed, false);
});

test('classifyProbe maps HTTP outcomes to verdicts', () => {
  assert.equal(classifyProbe(200), 'ok');
  assert.equal(classifyProbe(401), 'key');
  assert.equal(classifyProbe(403), 'rejected');
  assert.equal(classifyProbe(404), 'retired');
  assert.equal(classifyProbe(429), 'temporary');
  assert.equal(classifyProbe(503), 'temporary');
  assert.equal(classifyProbe('timeout'), 'temporary');
  assert.equal(classifyProbe('network'), 'temporary');
  assert.equal(classifyProbe(400), 'rejected');
});

test('findRegressions ignores ok and not-probed results and sorts by id', () => {
  const results = [
    { id: 'z:free', verdict: 'retired' },
    { id: 'a:free', verdict: 'ok' },
    { id: 'm:free', verdict: 'not-probed' },
    { id: 'b:free', verdict: 'paid' },
  ];
  assert.deepEqual(
    findRegressions(results).map((r) => r.id),
    ['b:free', 'z:free'],
  );
});

test('regressionSignature is empty when healthy and stable across order', () => {
  assert.equal(regressionSignature([]), '');
  const a = [{ id: 'a:free', verdict: 'retired' }, { id: 'b:free', verdict: 'paid' }];
  assert.equal(regressionSignature(findRegressions(a)), 'a:free=retired;b:free=paid');
});

test('alertDecision alerts once per distinct regression and sends one recovery', () => {
  assert.equal(alertDecision('', 'a:free=retired'), 'regression');
  assert.equal(alertDecision('a:free=retired', 'a:free=retired'), 'none');
  assert.equal(alertDecision('a:free=retired', 'a:free=retired;b:free=paid'), 'regression');
  assert.equal(alertDecision('a:free=retired', ''), 'recovery');
  assert.equal(alertDecision('', ''), 'none');
});

test('incomplete checks preserve prior findings and add newly confirmed regressions', () => {
  assert.equal(
    mergeRegressionSignatures('a:free=temporary', '', 'b:free=retired'),
    'a:free=temporary;b:free=retired',
  );
  assert.equal(mergeRegressionSignatures('a:free=temporary', 'a:free=ok'), 'a:free=ok');
});

test('failed regression and recovery notifications leave alert state retryable', () => {
  assert.equal(nextAlertedSignature('', 'a:free=retired', 'regression', 'failed'), '');
  assert.equal(nextAlertedSignature('a:free=retired', '', 'recovery', 'failed'), 'a:free=retired');
});

test('successful regression and recovery notifications update alert state', () => {
  assert.equal(nextAlertedSignature('', 'a:free=retired', 'regression', 'ok'), 'a:free=retired');
  assert.equal(nextAlertedSignature('a:free=retired', '', 'recovery', 'ok'), '');
});

test('high-priority alerts include OpenRouter key rejection and HTTP status', () => {
  const message = formatAlertMessage(
    'OpenRouter API key rejected (HTTP 401)',
    [{ id: 'a:free', verdict: 'retired', status: 'absent', durationMs: 0 }],
    { id: 'b:free', verdict: 'key', status: 401, durationMs: 20 },
  );
  assert.match(message, /OpenRouter API key rejected \(HTTP 401\)/);
  assert.match(message, /b:free  key  401/);
});

test('ntfy notification timeout is capped by the remaining run budget', () => {
  assert.equal(notificationTimeoutMs(20_000, 15_000), 5_000);
  assert.equal(notificationTimeoutMs(30_000, 15_000), 10_000);
  assert.throws(() => notificationTimeoutMs(15_000, 15_000), /budget exhausted/);
});

test('independent notifications start concurrently', async () => {
  const started = [];
  const release = [];
  const pending = deliverNotifications([
    ['alert', () => new Promise((resolve) => { started.push('alert'); release.push(() => resolve('ok')); })],
    ['summary', () => new Promise((resolve) => { started.push('summary'); release.push(() => resolve('ok')); })],
  ]);
  assert.deepEqual(started, ['alert', 'summary']);
  release.forEach((resolve) => resolve());
  assert.deepEqual(await pending, [['alert', 'ok'], ['summary', 'ok']]);
});

test('probe retries spend one shared budget unit per request', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response('{}', { status: 429 });
  };
  try {
    const budget = { remaining: 2 };
    const result = await probeModel('test-key', 'a:free', Date.now() + 10000, budget, async () => {});
    assert.equal(result.verdict, 'temporary');
    assert.equal(requests, 2);
    assert.equal(budget.remaining, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('model-specific 403 results do not stop probing later models', async () => {
  const originalFetch = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    models.push(model);
    if (model === 'a:free') return new Response('{}', { status: 403 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
  };
  try {
    const results = await checkChain(
      ['a:free', 'b:free'],
      new Map([['a:free', { free: true }], ['b:free', { free: true }]]),
      'test-key',
      { deadline: Date.now() + 10000 },
    );
    assert.deepEqual(models, ['a:free', 'b:free']);
    assert.deepEqual(results.map((result) => result.verdict), ['rejected', 'ok']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isFreePricing requires zero prompt and completion pricing', () => {
  assert.equal(isFreePricing({ prompt: '0', completion: '0' }), true);
  assert.equal(isFreePricing({ prompt: 0, completion: 0 }), true);
  assert.equal(isFreePricing({ prompt: '0.000001', completion: '0' }), false);
  assert.equal(isFreePricing(undefined), false);
});

test('carryForwardSignature drops findings for ids verified this run', () => {
  const results = [
    { id: 'a:free', verdict: 'ok' },
    { id: 'b:free', verdict: 'not-probed' },
  ];
  assert.equal(
    carryForwardSignature('a:free=temporary;b:free=rejected', results),
    'b:free=rejected',
  );
});

test('carryForwardSignature keeps the key finding when nothing was probed', () => {
  const results = [{ id: 'a:free', verdict: 'not-probed' }];
  assert.equal(
    carryForwardSignature('openrouter-key=rejected', results),
    'openrouter-key=rejected',
  );
  assert.equal(
    carryForwardSignature('openrouter-key=rejected', [{ id: 'a:free', verdict: 'ok' }]),
    '',
  );
});
