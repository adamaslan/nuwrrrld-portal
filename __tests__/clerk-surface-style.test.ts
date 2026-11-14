import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const landing = readFileSync(new URL('../app/landing.css', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/dashboard/dashboard.css', import.meta.url), 'utf8');
describe('Clerk restyle surfaces', () => {
  it('keeps public auth forms monochrome, square and without decorative shadows', () => {
    const css = landing.split('/* Clerk public auth surface restyle.')[1];
    expect(css).toBeDefined();
    expect(css).toContain('.public-auth');
    expect(css).toContain('.cl-signIn-root');
    expect(css).toContain('.cl-signUp-root');
    // Provider sign-in logos must keep their standard colors (Google
    // branding guidelines, required for OAuth app verification); a root
    // filter cannot be undone per-child, so the auth surface carries none.
    const rootRule = css.split('.cl-signUp-root) {')[1].split('}')[0];
    expect(rootRule).not.toContain('filter');
    // span.cl-providerIcon__* carries the provider logo as a CSS background
    // image; the universal background-image removal must exclude it.
    expect(css).toContain(':not([class*="cl-providerIcon"])');
    expect(css).toContain('border-radius: 0 !important');
    expect(css).toContain('box-shadow: none !important');
    expect(css).toContain('background-image: none !important');
    expect(css).toContain('.cl-formFieldInput');
    expect(css).toContain('border: var(--bw-supporting) solid var(--line-strong)');
  });
  it('covers the real account popup, not only its header trigger', () => {
    const css = dashboard.split('/* Clerk account popup restyle. */')[1];
    expect(css).toBeDefined();
    expect(css).toContain('.cl-userButtonPopoverRootBox');
    expect(css).toContain('filter: grayscale(1)');
    expect(css).toContain('border-radius: 0 !important');
    expect(css).toContain('box-shadow: none !important');
    expect(css).toContain('background-image: none !important');
    expect(css).toContain('.cl-userButtonPopoverCard');
    expect(css).toContain(':not([class*="cl-providerIcon"])');
  });
});

describe('Clerk account profile restyle', () => {
  it('covers the separate Manage account modal without changing account behavior', () => {
    const css = dashboard.split('/* Clerk account profile modal restyle. */')[1];
    expect(css).toBeDefined();
    expect(css).toContain('.cl-userProfile-root');
    expect(css).toContain('filter: grayscale(1)');
    expect(css).toContain('border-radius: 0 !important');
    expect(css).toContain('box-shadow: none !important');
    expect(css).toContain('background-image: none !important');
    expect(css).toContain('.cl-modalCloseButton');
    expect(css).toContain('border: var(--bw-standard) solid var(--border)');
  });
});
