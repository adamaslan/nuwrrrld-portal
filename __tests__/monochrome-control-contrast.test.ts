import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const globals = css('app/globals.css');
const tokens = Object.fromEntries([...globals.matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)].map(m => [m[1], m[2]]));
function declarations(path: string, selector: string) {
  const text = css(path);
  const block = text.split('}').find(part => part.slice(0, part.indexOf('{')).split(',').some(s => s.trim().endsWith(selector)));
  if (!block) throw new Error(`Missing CSS rule: ${selector}`);
  return Object.fromEntries([...block.slice(block.indexOf('{') + 1).matchAll(/([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
}
function resolve(value: string): string {
  if (!value.startsWith('var(')) return value;
  const name = value.slice(4, -1).split(',')[0].trim();
  return name === '--ink' ? tokens['--text'] : tokens[name];
}
function luminance(hex: string) {
  const values = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
}
const cases = [
  ['app/dashboard/dashboard.css', '.cockpit-brief-btn--locked'],
  ['app/dashboard/signals/signals.css', '.signals-expand-btn:hover'],
  ['app/dashboard/signals/signals.css', '.signals-watchlist-btn:hover:not(:disabled)'],
  ['app/dashboard/holdfold/holdfold.css', '.hf-watchlist-btn:hover:not(:disabled)'],
  ['app/dashboard/holdfold/holdfold.css', '.hf-live-advanced input'],
  ['components/consent.css', '.consent-btn'],
  ['components/disclaimer.css', '.disclaimer-btn'],
];
describe('monochrome control contrast regression', () => {
  for (const [path, selector] of cases) it(`${selector} declares readable foreground and background`, () => {
    const d = declarations(path, selector);
    expect(d.color).toBeDefined();
    expect(d.background).toBeDefined();
    const light = luminance(resolve(d.color));
    const dark = luminance(resolve(d.background));
    expect((Math.max(light, dark) + .05) / (Math.min(light, dark) + .05)).toBeGreaterThanOrEqual(4.5);
  });
});
