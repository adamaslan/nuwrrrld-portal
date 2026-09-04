#!/usr/bin/env node
/**
 * check-card-freshness — fail when the ranked universe has gone stale.
 *
 * Phase 1.5 of docs/signal-engine-three-phase-plan.md. The nightly hydration
 * outage (11 silent red runs, 15 days of aging cards) was invisible from
 * inside the writer: the writer was the thing that was broken. This check reads
 * `GET /api/pipeline/hydrate-universe?meta=freshness` — the newest `bar_date`
 * in `ticker_cards` — from *outside* the write path and exits non-zero when it
 * is more than MAX_STALE_TRADING_DAYS old.
 *
 * Test it by lowering the threshold, not by waiting three days:
 *   MAX_STALE_TRADING_DAYS=0 node scripts/check-card-freshness.mjs
 *
 * Usage:
 *   PORTAL_URL=... PORTAL_PUSH_SECRET=... node scripts/check-card-freshness.mjs
 *   MAX_STALE_TRADING_DAYS=3 node scripts/check-card-freshness.mjs   # default 3
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

let env = {};
try {
  const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  for (const line of envLocal.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]+)"?$/);
    if (m && m[1] && m[2]) env[m[1]] = m[2];
  }
} catch {
  /* .env.local absent — process.env is expected in CI */
}

// A non-HTTPS PORTAL_URL sends PORTAL_PUSH_SECRET in cleartext — acceptable
// only on loopback (local dev), never over a real network hop. CodeRabbit
// review, PR #101.
function assertSafePortalUrl(url) {
  const { protocol, hostname } = new URL(url);
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  if (protocol !== "https:" && !isLoopback) {
    throw new Error(
      `PORTAL_URL (${url}) is not HTTPS and not loopback — refusing to send PORTAL_PUSH_SECRET in cleartext.`,
    );
  }
}

const PORTAL_URL = (process.env.PORTAL_URL ?? env.PORTAL_URL ?? "https://financial.nuwrrrld.com").replace(/\/$/, "");
assertSafePortalUrl(PORTAL_URL);
const PORTAL_PUSH_SECRET = process.env.PORTAL_PUSH_SECRET ?? env.PORTAL_PUSH_SECRET;
const MAX_STALE_TRADING_DAYS = Number(process.env.MAX_STALE_TRADING_DAYS ?? "3");

if (!PORTAL_PUSH_SECRET) {
  console.error("check-card-freshness: PORTAL_PUSH_SECRET is not set");
  process.exit(2);
}
if (!Number.isInteger(MAX_STALE_TRADING_DAYS) || MAX_STALE_TRADING_DAYS < 0) {
  console.error(`check-card-freshness: MAX_STALE_TRADING_DAYS must be a non-negative integer (got ${MAX_STALE_TRADING_DAYS})`);
  process.exit(2);
}

const res = await fetch(`${PORTAL_URL}/api/pipeline/hydrate-universe?meta=freshness`, {
  headers: { Authorization: `Bearer ${PORTAL_PUSH_SECRET}` },
  signal: AbortSignal.timeout(30_000),
});

if (!res.ok) {
  console.error(`check-card-freshness: portal returned HTTP ${res.status}`);
  process.exit(2);
}

const { latestBarDate, staleTradingDays } = await res.json();

if (!latestBarDate) {
  console.error("::error::ticker_cards is empty — no cards have ever been written");
  process.exit(1);
}

const stale = staleTradingDays ?? 0;
const line = `latest bar_date=${latestBarDate} staleTradingDays=${stale} threshold=${MAX_STALE_TRADING_DAYS}`;

if (stale > MAX_STALE_TRADING_DAYS) {
  console.error(`::error::ranked universe is stale — ${line}`);
  process.exit(1);
}

console.log(`ranked universe is fresh — ${line}`);
