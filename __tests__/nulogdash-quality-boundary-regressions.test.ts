import { describe, expect, it } from 'vitest';
import { evaluateQualityEvidence, readQualityEvidence, unrecoveredNewsAccuracyEvidence } from '../lib/nulogdash-quality.mjs';

const fixture = () => ({
  source: { name: 'synthetic-test', version: '1', runId: 'fixture', evaluatorVersion: '1' },
  cutoffAt: '2026-11-22T20:00:00Z', evidenceScope: 'Synthetic regression only',
  workload: { eligible: 1, attempted: 1, useful: 1, skipped: 0, deferred: 0, errors: 0, items: [{ id: 'one', status: 'useful' }] },
  metrics: [{ id: 'accuracy', label: 'Accuracy', observed: .9, eligibleDenominator: 1, measuredDenominator: 1, target: { operator: '>=', value: .8, rationale: 'Synthetic target' } }],
});

describe('quality evidence read boundary', () => {
  it('keeps all thirteen missing metrics through the actual fallback reader', () => {
    const result = readQualityEvidence(unrecoveredNewsAccuracyEvidence());
    expect(result.metrics).toHaveLength(13);
    expect(result.metrics.every(metric => metric.verdict !== 'meets_target')).toBe(true);
    expect(result.metrics.find(metric => metric.id === 'delta_ic_h5')?.valueState).toBe('null');
  });
  it.each([2, .5, -1, Infinity, NaN])('blocks impossible measured denominator %s', value => {
    const input = fixture(); input.metrics[0].measuredDenominator = value;
    expect(evaluateQualityEvidence(input).metrics[0].verdict).toBe('blocked');
  });
  it.each(['not-a-date', '2026', '2026-11-22', '2026-11-22T25:00:00Z', '2026-02-30T00:00:00Z', '2026-04-31T00:00:00-04:00', '2026-11-22T24:00:00Z'])('does not grade invalid cutoff %s green', value => {
    const input = fixture(); input.cutoffAt = value;
    expect(evaluateQualityEvidence(input).metrics[0].verdict).not.toBe('meets_target');
  });
  it.each(['', '  ', undefined])('blocks an absent target rationale', value => {
    const input = fixture(); input.metrics[0].target.rationale = value;
    expect(evaluateQualityEvidence(input).metrics[0].verdict).toBe('blocked');
  });
  it('keeps a complete valid synthetic result measurable', () => {
    expect(evaluateQualityEvidence(fixture()).metrics[0].verdict).toBe('meets_target');
  });
  it.each([null, undefined])('fails closed on absent input without throwing', input => {
    expect(evaluateQualityEvidence(input).workload.verdict).not.toBe('measured');
  });
});


describe('malformed report normalization', () => {
  it.each(['__proto__', 'constructor', 'toString'])('blocks an inherited item status %s', status => {
    const input = fixture(); input.workload.useful = 0; input.workload.items[0].status = status;
    expect(evaluateQualityEvidence(input).workload.verdict).toBe('blocked');
    expect(evaluateQualityEvidence(input).metrics[0].verdict).toBe('blocked');
  });
  it.each([{}, [], 42, true])('does not restore an unsafe display reason %s', displayReason => {
    const input = { ...fixture(), schemaVersion: 'nulogdash-quality/v1', displayReason };
    expect(readQualityEvidence(input).displayReason).toBeNull();
  });
  it('preserves an ordinary string display reason', () => {
    const input = { ...fixture(), schemaVersion: 'nulogdash-quality/v1', displayReason: 'Synthetic report note' };
    expect(readQualityEvidence(input).displayReason).toBe('Synthetic report note');
  });
});
