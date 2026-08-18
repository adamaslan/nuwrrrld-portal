import { describe, expect, it } from 'vitest';

import fixtures from './fixtures/hydrate-indicator-parity.json';
import {
  adx,
  confluence,
  macdCross,
  rsi,
  volatilityPercentile,
} from '../scripts/lib/hydrate-indicators.mjs';

/**
 * Pins scripts/lib/hydrate-indicators.mjs to the numbers
 * deploy/universe-hydration/modal_app.py produces for the same inputs.
 *
 * The two implementations write rows into the SAME table, so a divergence is
 * not a style difference — it means two symbols hydrated by different runners
 * get scored on different scales. The fixture's expected values were captured
 * by running the Python functions directly over each input series.
 *
 * The tolerance is 1e-9 rather than exact equality only because the two
 * languages accumulate float error in a different order; anything looser would
 * stop catching the seeding bugs this test exists for (pandas' ewm skips a
 * leading NaN, while np.where and Series.combine do not — porting that wrong
 * shifted RSI by ~0.5 and ADX by ~0.9 in early drafts).
 */
const TOLERANCE = 1e-9;

type Fixture = {
  input: { close: number[]; high: number[]; low: number[] };
  expected: {
    rsi: number | null;
    macd: string | null;
    adx: number | null;
    vol: number | null;
  };
};

const cases = Object.entries(fixtures as Record<string, Fixture>);

describe('hydrate indicators match the Modal (Python) implementation', () => {
  it.each(cases)('%s', (_name, { input, expected }) => {
    const { close, high, low } = input;

    expect(rsi(close)).toBeCloseTo(expected.rsi as number, 9);
    expect(macdCross(close)).toBe(expected.macd);
    expect(adx(high, low, close)).toBeCloseTo(expected.adx as number, 9);
    expect(volatilityPercentile(close)).toBeCloseTo(expected.vol as number, 9);
  });

  it('holds every case within the stated tolerance', () => {
    for (const [name, { input, expected }] of cases) {
      const got = adx(input.high, input.low, input.close) as number;
      expect(Math.abs(got - (expected.adx as number)), name).toBeLessThan(TOLERANCE);
    }
  });
});

describe('insufficient history returns null rather than a fabricated reading', () => {
  const short = Array.from({ length: 20 }, (_, i) => 100 + i);

  it('rsi needs period + 1 bars', () => {
    expect(rsi(short.slice(0, 10))).toBeNull();
  });

  it('macdCross reports "missing", distinct from a computed no-cross null', () => {
    expect(macdCross(short)).toBe('missing');
  });

  it('adx needs 2 * period bars', () => {
    expect(adx(short, short, short)).toBeNull();
  });

  it('volatilityPercentile needs 2 * window bars', () => {
    expect(volatilityPercentile(short)).toBeNull();
  });
});

describe('confluence', () => {
  it('is deterministic across repeated calls on the same input', () => {
    const runs = new Set(
      Array.from({ length: 50 }, () => JSON.stringify(confluence(25, 'bullish', 30)))
    );
    expect(runs.size).toBe(1);
  });

  it('returns nulls when no indicator was computable', () => {
    expect(confluence(null, undefined, null)).toEqual({
      score: null,
      direction: null,
    });
  });

  it('scores full agreement higher than a split vote', () => {
    const agree = confluence(25, 'bullish', 10).score as number;
    const split = confluence(75, 'bullish', 10).score as number;
    expect(agree).toBeGreaterThan(split);
  });

  it('boosts agreement on a trending tape (adx >= 25), capped at 100', () => {
    const ranging = confluence(25, 'bullish', 10).score as number;
    const trending = confluence(25, 'bullish', 30).score as number;
    expect(trending).toBeGreaterThanOrEqual(ranging);
    expect(trending).toBeLessThanOrEqual(100);
  });
});
