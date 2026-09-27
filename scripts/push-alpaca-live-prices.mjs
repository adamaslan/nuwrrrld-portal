#!/usr/bin/env node
/**
 * Fill live_prices from Alpaca latest trades (IEX feed) for every ticker on the
 * paper-trading watchlists, so the paper engine has a reference price to fill
 * against. live_prices' only other writer is the Finnhub WebSocket worker,
 * which is not running; without a price a ticker cannot trade
 * (docs/ai-paper-trading-report-2026-09-26.md §4, §7 D1).
 *
 * Reads the union of the 8 accounts' watchlists from the public
 * /api/paper/[account]/watchlist, fetches Alpaca latest trades in chunks, and
 * POSTs one batch to /api/signals/live.
 *
 * Env: PORTAL_URL, PORTAL_PUSH_SECRET, ALPACA_API_KEY, ALPACA_API_SECRET.
 * Flags: --dry-run  fetch and report, POST nothing.
 * Never prints a credential. Uses the paper key's market-data access only.
 */
import {
  ALPACA_TRADES_URL,
  ALPACA_FEED,
  SYMBOLS_PER_REQUEST,
  chunk,
  toAlpacaSymbol,
  tradesToLivePrices,
} from "./lib/alpaca-live-prices.mjs";

const ACCOUNTS = ["t1", "t2", "risk", "macro", "quant", "chair", "equal", "spy"];
const dryRun = process.argv.includes("--dry-run");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is not set\n`);
    process.exit(1);
  }
  return value;
}

async function loadWatchlistTickers(portalUrl) {
  const tickers = new Set();
  for (const account of ACCOUNTS) {
    const res = await fetch(`${portalUrl}/api/paper/${account}/watchlist`);
    if (!res.ok) throw new Error(`watchlist ${account}: HTTP ${res.status}`);
    const body = await res.json();
    for (const entry of body.entries ?? []) if (entry.active) tickers.add(entry.ticker);
  }
  return [...tickers].sort();
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
const isTransient = (status) => status === 429 || status >= 500;

async function fetchTrades(symbols, headers) {
  const url = new URL(ALPACA_TRADES_URL);
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("feed", ALPACA_FEED);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()).trades ?? {};
    if (!isTransient(res.status) || attempt === MAX_ATTEMPTS) {
      throw new Error(`alpaca trades/latest: HTTP ${res.status}`);
    }
    const delayMs = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * BASE_BACKOFF_MS;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function main() {
  const portalUrl = requireEnv("PORTAL_URL").replace(/\/$/, "");
  const pushSecret = dryRun ? null : requireEnv("PORTAL_PUSH_SECRET");
  const headers = {
    "APCA-API-KEY-ID": requireEnv("ALPACA_API_KEY"),
    "APCA-API-SECRET-KEY": requireEnv("ALPACA_API_SECRET"),
  };

  const tickers = await loadWatchlistTickers(portalUrl);
  if (tickers.length === 0) throw new Error("no active watchlist tickers returned");

  const prices = [];
  for (const group of chunk(tickers, SYMBOLS_PER_REQUEST)) {
    // One failed chunk must not discard the chunks already fetched: a missing
    // price only means those tickers cannot trade this slot.
    try {
      const trades = await fetchTrades(group.map(toAlpacaSymbol), headers);
      prices.push(...tradesToLivePrices(group, trades));
    } catch (err) {
      process.stderr.write(`skipping ${group.length} tickers: ${err.message}\n`);
    }
  }
  process.stdout.write(
    `watchlist=${tickers.length} priced=${prices.length} missing=${tickers.length - prices.length} source=alpaca feed=${ALPACA_FEED}\n`,
  );
  if (prices.length === 0) throw new Error("Alpaca returned no usable prices");
  if (dryRun) return;

  const res = await fetch(`${portalUrl}/api/signals/live`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pushSecret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prices }),
  });
  process.stdout.write(`POST /api/signals/live -> HTTP ${res.status} ${await res.text()}\n`);
  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`push-alpaca-live-prices failed: ${err.message}\n`);
  process.exit(1);
});
