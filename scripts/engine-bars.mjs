#!/usr/bin/env node
/**
 * engine-bars — fetch daily bars from Alpaca and store them via
 * POST /api/pipeline/daily-bars, incrementally.
 *
 * Alpaca pagination and bad-symbol handling are copied from hydrate-local.mjs
 * rather than extracted, so this file conflicts with nothing that touches it.
 *
 *   node scripts/engine-bars.mjs                       # since latest stored bar - 7d
 *   node scripts/engine-bars.mjs --backfill-days=730   # full history
 *   node scripts/engine-bars.mjs --symbols=AAPL,MSFT --dry-run
 * Flags: --feed=iex|sip  --limit=N  --dry-run
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALPACA_ADJUSTMENT, ALPACA_FEED, ALPACA_PAGE_LIMIT, CHUNK_SIZE } from "../lib/shared/hydration-constants.mjs";

const OVERLAP_DAYS = 7;
const ALPACA_REQUEST_TIMEOUT_MS = 15_000;
const POST_BATCH_ROWS = 15_000;

const env = {};
try {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]+)"?$/);
    if (m) env[m[1]] = m[2];
  }
} catch {
  /* .env.local absent */
}
const get = (k) => process.env[k] ?? env[k];

function fail(message) {
  console.error(`engine-bars: ${message}`);
  process.exit(1);
}

const PORTAL_URL = (get("PORTAL_URL") ?? "http://localhost:3000").replace(/\/$/, "");
{
  const { protocol, hostname } = new URL(PORTAL_URL);
  if (protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    fail(`PORTAL_URL (${PORTAL_URL}) is not HTTPS and not loopback — refusing to send the push secret in cleartext.`);
  }
}
const SECRET = get("PORTAL_PUSH_SECRET");
const KEY = get("ALPACA_API_KEY");
const KEY_SECRET = get("ALPACA_API_SECRET");
if (!SECRET) fail("PORTAL_PUSH_SECRET is not set");
if (!KEY || !KEY_SECRET) fail("ALPACA_API_KEY / ALPACA_API_SECRET are not set");

const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DRY_RUN = process.argv.includes("--dry-run");
const FEED = flag("feed") ?? ALPACA_FEED;
if (!["iex", "sip"].includes(FEED)) fail("--feed must be iex or sip");
const positiveInt = (name) => {
  const raw = flag(name);
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw) || Number(raw) === 0) fail(`--${name} must be a positive integer`);
  return Number(raw);
};
const BACKFILL_DAYS = positiveInt("backfill-days");
const LIMIT = positiveInt("limit");
const symbolsRaw = flag("symbols");
const SYMBOLS = symbolsRaw ? symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) : null;
if (symbolsRaw && !SYMBOLS.length) fail("--symbols must be a comma-separated list of tickers");

const portal = (path, init = {}) =>
  fetch(`${PORTAL_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", ...init.headers },
  });

async function activeTickers() {
  const all = [];
  for (const universe of ["stock", "etf"]) {
    const res = await portal(`/api/pipeline/hydrate-universe?universe=${universe}`);
    if (!res.ok) throw new Error(`universe fetch failed: ${res.status}`);
    all.push(...((await res.json()).tickers ?? []));
  }
  return all;
}

async function startDate() {
  const day = (d) => d.toISOString().slice(0, 10);
  const back = (days) => day(new Date(Date.now() - days * 86_400_000));
  if (BACKFILL_DAYS) return back(BACKFILL_DAYS);
  const res = await portal("/api/pipeline/daily-bars");
  if (!res.ok) throw new Error(`latest-bar lookup failed: ${res.status}`);
  const latest = (await res.json()).latest?.[FEED];
  if (!latest) fail(`no stored ${FEED} bars — pass --backfill-days=N for the first run`);
  return day(new Date(Date.parse(`${latest}T00:00:00Z`) - OVERLAP_DAYS * 86_400_000));
}

async function fetchBarsOnce(symbols, start) {
  const merged = {};
  let pageToken = null;
  do {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", start);
    url.searchParams.set("limit", String(ALPACA_PAGE_LIMIT));
    url.searchParams.set("feed", FEED);
    url.searchParams.set("adjustment", ALPACA_ADJUSTMENT);
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await fetch(url, {
      headers: { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": KEY_SECRET },
      signal: AbortSignal.timeout(ALPACA_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Alpaca returned ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const [sym, bars] of Object.entries(data.bars || {})) (merged[sym] ??= []).push(...bars);
    pageToken = data.next_page_token || null;
  } while (pageToken);
  return merged;
}

/** One bad symbol costs only itself: Alpaca 400s the whole request on "invalid symbol: X". */
async function fetchBars(symbols, start) {
  let remaining = [...symbols];
  const dropped = [];
  while (remaining.length > 0) {
    try {
      const bars = await fetchBarsOnce(remaining, start);
      if (dropped.length) console.log(`  (skipped ${dropped.length} unusable: ${dropped.join(", ")})`);
      return bars;
    } catch (e) {
      const bad = /invalid symbol:\s*([^"'}\s]+)/i.exec(e.message)?.[1];
      if (!bad || !remaining.includes(bad)) throw e;
      dropped.push(bad);
      remaining = remaining.filter((s) => s !== bad);
    }
  }
  return {};
}

async function post(rows) {
  const res = await portal("/api/pipeline/daily-bars", {
    method: "POST",
    body: JSON.stringify({ feed: FEED, adjustment: ALPACA_ADJUSTMENT, source: "alpaca", rows }),
  });
  if (!res.ok) throw new Error(`daily-bars POST failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const start = await startDate();
  let targets = SYMBOLS ?? (await activeTickers());
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`[start] feed=${FEED} since=${start} symbols=${targets.length} dryRun=${DRY_RUN}`);

  let fetched = 0;
  let written = 0;
  let rejected = 0;
  let buffer = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    if (!DRY_RUN) {
      const out = await post(buffer);
      written += out.written;
      rejected += out.rejectedCount ?? 0;
    }
    buffer = [];
  };

  for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
    const chunk = targets.slice(i, i + CHUNK_SIZE);
    const bars = await fetchBars(chunk, start);
    for (const [ticker, list] of Object.entries(bars)) {
      for (const b of list) {
        buffer.push({ ticker, barDate: b.t.slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
        fetched += 1;
      }
    }
    if (buffer.length >= POST_BATCH_ROWS) await flush();
  }
  await flush();
  console.log(`[done] symbols=${targets.length} fetched=${fetched} written=${written} rejected=${rejected}`);
  if (fetched === 0 && targets.length > 0) fail("attempted symbols but fetched no bars");
}

main().catch((e) => fail(e.message));
