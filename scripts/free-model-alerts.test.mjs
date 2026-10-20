import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffChains, parseChain } from './free-model-chain.mjs';
import {
  alertDecision,
  classifyProbe,
  findRegressions,
  isFreePricing,
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
  assert.equal(classifyProbe(403), 'key');
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

test('isFreePricing requires zero prompt and completion pricing', () => {
  assert.equal(isFreePricing({ prompt: '0', completion: '0' }), true);
  assert.equal(isFreePricing({ prompt: 0, completion: 0 }), true);
  assert.equal(isFreePricing({ prompt: '0.000001', completion: '0' }), false);
  assert.equal(isFreePricing(undefined), false);
});
