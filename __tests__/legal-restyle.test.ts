import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync(new URL('../app/legal.css', import.meta.url), 'utf8');
describe('legal page restyle', () => {
  it('uses a flat background without decorative gradients', () => {
    expect(css).not.toMatch(/(?:radial|linear)-gradient\(/);
    expect(css).toMatch(/background:\s*var\(--bg\)/);
  });
  it('keeps the shared brand mark readable and square', () => {
    const mark = css.split('.nwf-legal .brand-mark')[1].split('}')[0];
    expect(mark).toMatch(/background:\s*var\(--fill-strong\)/);
    expect(mark).toMatch(/color:\s*var\(--bg\)/);
    expect(mark).toMatch(/border-radius:\s*0/);
  });
});

describe('legal page text boundaries', () => {
  // JSX trims leading whitespace of a text node that spans a newline, so
  // "advice.</strong> Our Service ..." rendered as "advice.Our". The explicit
  // {" "} boundary keeps the space without changing any legal wording.
  it('keeps an explicit space boundary after the inline strong in Terms', () => {
    const tsx = readFileSync(new URL('../app/terms-of-service/page.tsx', import.meta.url), 'utf8');
    expect(tsx).toContain('advice.</strong>{" "}Our Service');
    expect(tsx).not.toMatch(/advice\.<\/strong> Our/);
  });
  it('keeps explicit space boundaries after every inline strong in Privacy', () => {
    const tsx = readFileSync(new URL('../app/privacy-policy/page.tsx', import.meta.url), 'utf8');
    // Every </strong> followed by text must use an explicit {" "} boundary;
    // a literal space is trimmed whenever the text node spans a newline.
    const bare = tsx.match(/<\/strong> [^{]/g) || [];
    expect(bare).toEqual([]);
    expect(tsx).toContain('<strong>Stripe</strong>{" "}- payment processing');
    expect(tsx).toContain('<strong>Right to access:</strong>{" "}You may request');
  });
});
