import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { latestComputedAt, tokenStrength } from '@/lib/shared/stored-card-honesty';

describe('latestComputedAt', () => {
  it('selects the chronologically latest weekday-prefixed timestamp, not the lexical last', () => {
    const cards = [
      { computedAt: 'Sat Oct 24 2026 12:57:00 GMT+0000 (Coordinated Universal Time)' },
      { computedAt: 'Fri Nov 13 2026 02:49:03 GMT+0000 (Coordinated Universal Time)' },
    ];
    expect(latestComputedAt(cards)).toContain('Nov 13');
  });
  it('skips unparseable entries instead of crowning them', () => {
    expect(latestComputedAt([{ computedAt: 'zzz not a date' }, { computedAt: 'Mon Nov 02 2026 10:00:00 GMT+0000' }])).toContain('Nov 02');
    expect(latestComputedAt([{ computedAt: 'nope' }])).toBe('');
    expect(latestComputedAt([])).toBe('');
  });
});

describe('tokenStrength', () => {
  it('derives strength from the indicator value, never the overall card direction', () => {
    expect(tokenStrength('bullish_cross')).toBe('bullish');
    expect(tokenStrength('bearish_divergence')).toBe('bearish');
    expect(tokenStrength('neutral')).toBe('neutral');
    expect(tokenStrength('trending')).toBe('neutral');
    expect(tokenStrength('normal')).toBe('neutral');
  });
});

describe('honest labeling stays in place', () => {
  const storedSignals = readFileSync(new URL('../app/dashboard/holdfold/stored-signals.ts', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../app/dashboard/holdfold/HoldFoldClient.tsx', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../app/dashboard/holdfold/page.tsx', import.meta.url), 'utf8');
  it('aggregate selection never sorts timestamps as text', () => {
    expect(storedSignals).not.toMatch(/computedAt\)\.sort\(\)/);
    expect(storedSignals).toContain('latestComputedAt(cards)');
  });
  it('per-indicator badges come from the token value', () => {
    expect(storedSignals).toContain('strength: tokenStrength(value)');
    expect(storedSignals).not.toContain('strength: card.tokens.direction');
  });
  it('stored summary is not labeled fresh AI analysis', () => {
    expect(client).not.toContain('AI OUTLOOK');
    expect(client).toContain('STORED SIGNAL SUMMARY');
  });
  it('aggregate header says computed, not updated', () => {
    expect(index).toContain('Signals computed {formatUpdated(data.updatedAt)}');
    expect(index).not.toContain('Updated {formatUpdated(data.updatedAt)}');
  });
  it('per-card dates show market bar and calculation, marked unknown when absent', () => {
    expect(client).toContain('Market bar {v.barDate ?? "unknown"}');
  });
});
