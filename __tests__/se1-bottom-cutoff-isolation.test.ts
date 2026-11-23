import { describe, expect, it } from 'vitest';
import { failedBreakdownReclaim, secondLowContraction, postCapitulationStabilization, downsideFollowThroughFailure, gapDownRepairLadder, downsideRejectionRecovery, type Bar } from '@/lib/shared/se1/bottom-scans';

const cutoff = '2026-01-22';
const closes = [105,104,90,100,105,106,107,108,109,110,111,112,113,114,115,116,117,118,85,100,105,110];
const bars: Bar[] = closes.map((close, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: close, high: close + 1, low: close - 1, close, volume: 100 }));
const scans = [
  ['reclaim', (input: Bar[]) => failedBreakdownReclaim(input, { cutoff, supportWindow: 5, reclaimWindow: 3, atrWindow: 3 })],
  ['second low', (input: Bar[]) => secondLowContraction(input, { cutoff, pivotK: 1, minSeparation: 10, atrWindow: 3 })],
  ['stabilization', (input: Bar[]) => postCapitulationStabilization(input, { cutoff, volumeWindow: 5, minDrop: .05, volumeMultiple: 1, quietWindow: 2 })],
  ['follow through', (input: Bar[]) => downsideFollowThroughFailure(input, { cutoff, supportWindow: 5 })],
  ['gap ladder', (input: Bar[]) => gapDownRepairLadder(input, { cutoff, minGap: .05 })],
  ['rejection', (input: Bar[]) => downsideRejectionRecovery(input, { cutoff, supportWindow: 5, minWickFraction: .2, recoverFraction: .5, nearSupport: .05 })],
] as const;
const fields = ['open', 'high', 'low', 'close', 'volume'] as const;
const invalidValues = [NaN, Infinity, -1];

describe.each(scans)('%s cutoff isolation', (_name, scan) => {
  it('ignores invalid future numeric payloads while counting the excluded bar', () => {
    const baseline = scan(bars);
    expect(baseline.status).toBe('computed');
    for (const field of fields) for (const value of invalidValues) {
      const future: Bar = { ...bars[0], date: '2026-01-23', [field]: value };
      const input = [future, ...bars].map(bar => Object.freeze({ ...bar }));
      const actual = scan(input);
      expect(actual).toEqual({ ...baseline, excluded_after_cutoff: 1 });
      expect(input[0][field]).toBe(value);
    }
  });

  it('still rejects invalid numeric payloads on or before cutoff', () => {
    for (const field of fields) for (const value of invalidValues) {
      const input = bars.map((bar, i) => i === bars.length - 1 ? { ...bar, [field]: value } : { ...bar });
      expect(() => scan(input)).toThrow(RangeError);
    }
  });

  it('keeps malformed dates rejected', () => {
    expect(() => scan([...bars, { ...bars[0], date: 'not-a-date' }])).toThrow(RangeError);
  });
});
