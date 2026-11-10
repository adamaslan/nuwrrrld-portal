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
