import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const holdfold = read('app/dashboard/holdfold/holdfold.css');
function rule(css: string, selector: string) {
  return css.split('}').find(block => block.slice(0, block.indexOf('{')).trim().endsWith(selector))?.split('{')[1] ?? '';
}

describe('restyle visual-audit regressions', () => {
  it('reserves a separate touch target for closing a verdict, outside the title/watchlist row', () => {
    const close = rule(holdfold, '.hf-close');
    expect(close).toMatch(/position:\s*static/);
    expect(close).toMatch(/align-self:\s*flex-end/);
    expect(close).toMatch(/min-width:\s*44px/);
    expect(close).toMatch(/min-height:\s*44px/);
    expect(rule(holdfold, '.hf-detail-title')).toMatch(/flex-wrap:\s*wrap/);
  });
  it('places the selected verdict before the long list on narrow screens', () => {
    expect(holdfold).toMatch(/@media\s*\(max-width:\s*899px\)\s*\{\s*\.hf-detail\s*\{[^}]*grid-row:\s*1/);
  });
  it('does not use a shadow on the legal acknowledgement dialog', () => {
    expect(rule(read('components/disclaimer.css'), '.disclaimer-modal')).toMatch(/box-shadow:\s*none/);
  });
  it('keeps the beta feedback glyph monochrome without changing its meaning', () => {
    expect(read('app/dashboard/beta/page.tsx')).toContain('className="beta-feedback-icon"');
    expect(rule(read('app/dashboard/beta/beta.css'), '.beta-feedback-icon')).toMatch(/filter:\s*grayscale\(1\)/);
  });
});
