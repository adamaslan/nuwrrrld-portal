import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
describe('pipeline subject layout', () => {
  it('preserves the full subject in a keyboard-scrollable labelled region', () => {
    const source = read('app/dashboard/nulogdash/pipelines/[id]/page.tsx');
    expect(source).toMatch(/<div className="nld-item-subject" tabIndex=\{0\} role="region" aria-label="Full subject">\{item.subject\}<\/div>/);
  });
  it('bounds a very long subject in both dimensions and wraps unbroken ticker lists', () => {
    const css = read('app/dashboard/nulogdash/nulogdash.css');
    const rule = css.split('}').find(b => b.includes('.nld-item-subject {')) ?? '';
    expect(rule).toMatch(/width:\s*min\(18rem,\s*40vw\)/);
    expect(rule).toMatch(/max-height:\s*8rem/);
    expect(rule).toMatch(/overflow:\s*auto/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/white-space:\s*normal/);
  });
});
