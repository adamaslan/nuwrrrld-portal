import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BLOG_ARTICLES } from '@/lib/blog/articles';
import fixture from '@/lib/blog/backtest-fixture.json';
const copy = JSON.stringify(BLOG_ARTICLES);
describe('blog release evidence', () => {
  it('does not confuse positive returns with beating the benchmark', () => {
    expect(copy).not.toContain('ahead on 21');
    expect(copy).toContain('positive total return on 21');
    expect(copy).toContain('outperformed buy-and-hold on 8');
  });
  it('recomputes the published headlines from saved per-ticker aggregates', () => {
    const rows = fixture.rows;
    const trades = rows.reduce((n, r) => n + r.nwf.trades, 0);
    expect(trades).toBe(3019);
    expect((100 * rows.reduce((n, r) => n + r.nwf.trades * r.nwf.hit_rate, 0) / trades).toFixed(1)).toBe('54.2');
    expect((100 * rows.reduce((n, r) => n + r.nwf.trades * r.nwf.avg_return, 0) / trades).toFixed(2)).toBe('0.47');
    expect(rows.filter(r => r.nwf.total_return > 0)).toHaveLength(21);
    expect(rows.filter(r => r.nwf.total_return > r.nwf.buyhold)).toHaveLength(8);
    const calls = rows.reduce((n, r) => n + r.sig.calls, 0);
    expect(calls).toBe(258932);
    expect((100 * rows.reduce((n, r) => n + r.sig.hits, 0) / calls).toFixed(1)).toBe('50.4');
    expect((100 * rows.reduce((n, r) => n + r.sig.calls * r.sig.chance, 0) / calls).toFixed(1)).toBe('50.4');
  });
  it('has a source link and visible basis beside every stats/table block', () => {
    const page = readFileSync('app/blog/[slug]/page.tsx', 'utf8');
    expect(page).toContain('/blog/backtest-evidence.json');
    expect(page.match(/BLOG_RETURN_BASIS/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toContain('saved aggregates');
  });
  it('keeps current navigation with an accessible Blog destination', () => {
    const home = readFileSync('app/page.tsx','utf8');
    expect(home).toContain('<PreLoginNav />');
    expect(home).not.toContain('<<<<<<<');
    expect(readFileSync('components/landing/PreLoginShell.tsx','utf8')).toContain('["Blog", "/blog"]');
  });
});
