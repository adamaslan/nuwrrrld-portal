/**
 * Pure helpers for pushing Alpaca latest trades into live_prices
 * (scripts/push-alpaca-live-prices.mjs). No I/O so they can be unit-tested.
 *
 * Symbology: the portal stores share classes with a hyphen (BRK-B), Alpaca
 * wants a dot (BRK.B). Same rule as normalizeToAlpaca in
 * scripts/seed-signals-universe.mjs, duplicated because importing that file
 * drags in the seeder's DB setup.
 */
const SHARE_CLASS_RE = /^([A-Z]+)-([A-Z])$/;

export const ALPACA_TRADES_URL = "https://data.alpaca.markets/v2/stocks/trades/latest";
export const ALPACA_FEED = "iex";
export const SYMBOLS_PER_REQUEST = 100;
// A long holiday weekend leaves the last trade 4 days old (Fri close, Tue
// open); anything older is a stale or pre-symbol-change print, not a price.
export const MAX_TRADE_AGE_MS = 5 * 24 * 60 * 60 * 1000;

export function toAlpacaSymbol(ticker) {
  const m = SHARE_CLASS_RE.exec(ticker);
  return m ? `${m[1]}.${m[2]}` : ticker;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Map an Alpaca `{ trades: { SYM: { p, s, t } } }` response back onto portal
 * tickers. Symbols Alpaca did not return, or returned with a non-positive
 * price or a trade older than MAX_TRADE_AGE_MS, are dropped: a missing price
 * means no trade, never a stale fill.
 */
export function tradesToLivePrices(tickers, trades, now = Date.now()) {
  const rows = [];
  for (const ticker of tickers) {
    const trade = trades?.[toAlpacaSymbol(ticker)];
    if (!trade || !(trade.p > 0) || !trade.t) continue;
    const tradedAtMs = Date.parse(trade.t);
    if (!Number.isFinite(tradedAtMs) || now - tradedAtMs > MAX_TRADE_AGE_MS) continue;
    rows.push({
      ticker,
      price: trade.p,
      tradedAt: trade.t,
      volume: Number.isFinite(trade.s) ? trade.s : null,
    });
  }
  return rows;
}
