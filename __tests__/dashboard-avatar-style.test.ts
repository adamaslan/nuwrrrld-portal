import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../app/dashboard/dashboard.css', import.meta.url), 'utf8');
function rule(selector: string) {
  return css.split('}').find(block => block.slice(0, block.indexOf('{')).split(',').some(part => part.trim().endsWith(selector)))?.split('{')[1] ?? '';
}

describe('dashboard account avatar restyle', () => {
  it('keeps both the account button and image clip square', () => {
    for (const selector of ['.cl-userButtonTrigger', '.cl-userButtonAvatarBox']) {
      expect(rule(selector)).toMatch(/border-radius:\s*0\s*!important/);
    }
  });
  it('renders an uploaded avatar in monochrome without altering the image or account', () => {
    expect(rule('.cl-userButtonAvatarImage')).toMatch(/filter:\s*grayscale\(1\)/);
  });
});
