/** Offline layout regression. No Next server, Clerk, database or provider calls.
 * Run: node --import tsx scripts/test-council-layout.tsx
 * Uses the real component's SSR markup and repository CSS, not a copied layout.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

async function main() {
  // This repository's component-test JSX transform supplies React globally.
  Object.assign(globalThis, { React });
  const { CouncilScrollDebate } = await import('../components/landing/CouncilScrollDebate');
  const markup = renderToStaticMarkup(<CouncilScrollDebate />);
  const css = ['app/globals.css', 'app/landing.css'].map(p => readFileSync(p, 'utf8')).join('\n');
  const browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {});
  try {
    for (const [width, height] of [[1440, 1000], [1440, 700], [1024, 900], [390, 844], [320, 720]]) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.setContent(`<style>${css}</style><div class="nwf-landing"><div style="height:1200px"></div><section><div class="wrap">${markup}<h2>Next section</h2></div></section><div style="height:1200px"></div></div>`);
      const panel = page.locator('.council-debate');
      const box = (await panel.boundingBox())!;
      await page.evaluate(y => scrollTo(0, y), box.y + height);
      const result = await panel.evaluate(e => {
        const inner = e.querySelector('.council-debate-sticky')!;
        const rect = inner.getBoundingClientRect();
        return {
          height: e.getBoundingClientRect().height, panelHeight: rect.height,
          top: rect.top, position: getComputedStyle(inner).position,
          overflow: document.documentElement.scrollWidth > innerWidth,
          hiddenLines: [...e.querySelectorAll('.council-debate-line')].filter(line => Number(getComputedStyle(line).opacity) < 1).length,
        };
      });
      assert.equal(result.overflow, false, `${width} horizontal overflow`);
      if (width > 1024 && height > 820) {
        assert.ok(Math.abs(result.top - 90) <= 2, `desktop sticky disappeared: ${result.top}`);
        assert.ok(result.panelHeight + 90 <= height, 'pinned content taller than viewport');
      } else {
        assert.equal(result.position, 'static');
        assert.ok(Math.abs(result.height - result.panelHeight) <= 2, 'reserved blank scroll space');
        assert.equal(result.hiddenLines, 0, 'static answers must all be readable');
      }
      console.log(`PASS ${width}x${height}`);
      await page.close();
    }
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
