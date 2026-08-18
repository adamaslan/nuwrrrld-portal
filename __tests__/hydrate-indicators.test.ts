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
  /**
   * null is a real, meaningful outcome here (not-enough-history), so it has to
   * be asserted as null rather than coerced into a number — toBeCloseTo(null)
   * would silently pass against 0 and hide a genuinely missing reading.
   */
  const expectMatch = (got: number | null, want: number | null) => {
    if (want === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(want, 9);
  };

  it.each(cases)('%s', (_name, { input, expected }) => {
    const { close, high, low } = input;

    expectMatch(rsi(close), expected.rsi);
    expect(macdCross(close)).toBe(expected.macd);
    expectMatch(adx(high, low, close), expected.adx);
    expectMatch(volatilityPercentile(close), expected.vol);
  });

  /**
   * The six original fixtures all happen to produce a *no-cross* null from
   * macdCross, so the "bullish"/"bearish" branches — the values the pipeline
   * actually acts on — went unverified against Python until these two cases
   * were added. Guard that they stay covered.
   */
  it('covers both crossover directions against the Python reference', () => {
    const seen = cases.map(([, c]) => c.expected.macd);
    expect(seen).toContain('bullish');
    expect(seen).toContain('bearish');
  });

  it('holds every case within the stated tolerance', () => {
    for (const [name, { input, expected }] of cases) {
      if (expected.adx === null) continue;
      const got = adx(input.high, input.low, input.close) as number;
      expect(Math.abs(got - expected.adx), name).toBeLessThan(TOLERANCE);
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

/**
 * scripts/hydrate-local.mjs only returns status "ok" at MIN_BARS = 40, on the
 * claim that 40 is the largest lookback any indicator needs. If that claim ever
 * stops holding, rows go back to persisting fabricated 0/0/50 readings as if
 * they were measured — so the boundary itself is pinned, not just assumed.
 */
describe('MIN_BARS = 40 is the exact threshold where all four indicators compute', () => {
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 5) * 6 + i * 0.2);

  const allComputable = (n: number) => {
    const close = series(n);
    const high = close.map(c => c * 1.01);
    const low = close.map(c => c * 0.99);
    return (
      rsi(close) !== null &&
      macdCross(close) !== 'missing' &&
      adx(high, low, close) !== null &&
      volatilityPercentile(close) !== null
    );
  };

  it('39 bars is not enough (volatilityPercentile still null)', () => {
    expect(allComputable(39)).toBe(false);
  });

  it('40 bars is enough', () => {
    expect(allComputable(40)).toBe(true);
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
