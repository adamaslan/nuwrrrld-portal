import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Isolated CSS fixtures: no server, auth, model calls or account writes.
// These catch intrinsic-width overflow, not live-route functional regressions.
const css = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const globals = css('app/globals.css');
const cells = ['Account', 'NAV', 'Return', 'Sharpe', 'Max DD', 'Hit rate', 'vs SPY', 'Day', 'Vol', 'Turnover', 'Hold (d)', 'Payoff'];
const table = `<table class="pa-table nld-table"><thead><tr>${cells.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody><tr>${cells.map((_, i) => `<td>${i ? '$10,903' : 'T2 - Long-Horizon Compounder'}</td>`).join('')}</tr></tbody></table>`;
for (const width of [390, 1280]) {
  test(`Arena contains wide table at ${width}px`, async ({ page }) => {
    await page.route('**/*', route => route.abort());
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<style>${globals}${css('app/dashboard/council/portfolios/paper-portfolios.css')}${css('app/dashboard/council/portfolios/arena/arena.css')}</style><main class="pp-page pa-page"><h1>Paper Account Arena</h1><p class="pp-sub">Six AI-council accounts judged against two baselines. Simulated books, no real money.</p><div class="pa-stack"><section><p class="pa-note">Fixture: prose must wrap; the table scrolls within its own box.</p><div class="pa-scroll">${table}</div></section><section><div class="pa-legend">${cells.map(c => `<button class="pa-legend-item">${c}</button>`).join('')}</div></section></div></main>`);
    for (const selector of ['main', 'h1', '.pp-sub', '.pa-stack', '.pa-note', '.pa-legend', '.pa-scroll']) {
      const box = await page.locator(selector).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    if (width === 390) expect(await page.locator('.pa-scroll').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  });
  test(`Pipeline page contains wide table at ${width}px`, async ({ page }) => {
    await page.route('**/*', route => route.abort());
    await page.setViewportSize({ width, height: 844 });
    await page.setContent(`<style>${globals}${css('app/dashboard/nulogdash/nulogdash.css')}</style><main class="nld-page"><h1>Pipeline runs</h1><p class="nld-meta">Every scheduled workload and what it last recorded, by category. Model pipelines write pipeline_run_log.</p><nav class="nld-jump">${cells.map(c => `<a class="nld-tab">${c}</a>`).join('')}</nav><div class="nld-cards"><div class="nld-card">FOLLOWED TICKERS</div></div><div class="nld-table-wrap">${table}</div></main>`);
    for (const selector of ['main', 'h1', '.nld-meta', '.nld-jump', '.nld-cards', '.nld-table-wrap']) {
      const box = await page.locator(selector).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
    if (width === 390) expect(await page.locator('.nld-table-wrap').evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  });
}

for (const width of [390, 1280]) test(`Upgrade comparison fits at ${width}px`, async ({ page }) => {
  await page.route('**/*', route => route.abort());
  await page.setViewportSize({ width, height: 844 });
  await page.setContent(`<style>${globals}${css('app/dashboard/upgrade/upgrade.css')}</style><main class="upgrade-page"><div class="upgrade-hero"><h1>Switch to annual billing</h1><p class="upgrade-sub">Switch to annual and pay just $6.67/mo. Same everything, lower price.</p></div><div class="upgrade-comparison"><div class="upgrade-plan"><p class="plan-price">$9.99<span>/mo</span></p><p>$119.88/yr</p></div><div class="upgrade-arrow">→</div><div class="upgrade-plan upgrade-plan--annual"><p class="plan-price">$6.67<span>/mo</span></p><p>$79.99/yr · save $39.89</p></div></div><button class="checkout-btn">Switch to annual</button><p class="upgrade-note">Your monthly subscription will be cancelled and the annual plan starts immediately.</p></main>`);
  for (const selector of ['main', '.upgrade-hero', '.upgrade-sub', '.upgrade-comparison', '.checkout-btn', '.upgrade-note']) {
    const box = await page.locator(selector).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
  for (const box of await page.locator('.upgrade-plan').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right }; }))) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width + 1);
  }
});

for (const width of [390, 1280]) test(`Pipeline detail contains long run/model/item values at ${width}px`, async ({ page }) => {
  const source = css('app/dashboard/nulogdash/pipelines/[id]/page.tsx');
  expect(source.match(/className="nld-table-wrap"/g)).toHaveLength(2);
  await page.route('**/*', route => route.abort());
  await page.setViewportSize({ width, height: 844 });
  const long = 'A,AA,AAPL,AAPU,ABBV,ABNB,ABSI,ABT,'.repeat(20);
  await page.setContent(`<style>${globals}${css('app/dashboard/nulogdash/nulogdash.css')}</style><main class="nld-page"><h1>precompute-ai</h1><p class="nld-meta">Nov 9 · live run · <code>98b97059-4434-49e0-be7f-d876639ff5b1</code></p><section><h2>Per model</h2><div class="nld-table-wrap"><table class="nld-table"><tr><td>nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free</td><td>6</td><td>7175ms</td></tr></table></div></section><section><h2>Items</h2><div class="nld-table-wrap"><table class="nld-table"><tr><td>${long}</td><td>fail</td></tr></table></div></section><pre class="nld-pre">${long}</pre></main>`);
  for (const selector of ['main', 'h1', '.nld-meta', '.nld-pre']) {
    const box = await page.locator(selector).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  }
  for (const dimensions of await page.locator('.nld-table-wrap').evaluateAll(nodes => nodes.map(n => {const r = n.getBoundingClientRect(); return {left:r.left,right:r.right,scroll:n.scrollWidth,client:n.clientWidth};}))) {
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(width + 1);
  }
  expect(await page.locator('.nld-table-wrap').nth(1).evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
});
