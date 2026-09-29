/**
 * live-price-db — Neon persistence for the real-time price feed. Like the other
 * cache stores (holdfold-cache-db, signal_cache), writes are best-effort: the
 * live-price lane is an enhancement, never a hard dependency. Reads return null
 * on any failure so a page that wants a live quote degrades to the (slower)
 * signal cache rather than erroring.
 */
import sql from "@/lib/db";
import type { LivePrice } from "@/lib/shared/live-price";

/** Upsert a batch of latest-per-ticker prices. Returns how many rows were written. */
export async function upsertLivePrices(rows: LivePrice[]): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    // One statement, unnested arrays — a single round-trip for the whole batch.
    const tickers = rows.map((r) => r.ticker);
    const prices = rows.map((r) => r.price);
    const volumes = rows.map((r) => r.volume);
    const tradedAts = rows.map((r) => r.tradedAt);
    await sql`
      INSERT INTO live_prices (ticker, price, volume, traded_at)
      SELECT * FROM unnest(
        ${tickers}::text[],
        ${prices}::numeric[],
        ${volumes}::bigint[],
        ${tradedAts}::timestamptz[]
      ) AS t(ticker, price, volume, traded_at)
      ON CONFLICT (ticker) DO UPDATE
        SET price = EXCLUDED.price,
            volume = EXCLUDED.volume,
            traded_at = EXCLUDED.traded_at,
            updated_at = now()
        -- Never let an out-of-order tick overwrite a newer one.
        WHERE EXCLUDED.traded_at >= live_prices.traded_at
    `;
    return rows.length;
  } catch {
    return 0;
  }
}

export interface LivePriceRecord {
  ticker: string;
  price: number;
  volume: number | null;
  tradedAt: string;
  updatedAt: string;
}

export async function getLivePrice(ticker: string): Promise<LivePriceRecord | null> {
  try {
    const out = await sql`
      SELECT ticker, price, volume, traded_at, updated_at
      FROM live_prices WHERE ticker = ${ticker} LIMIT 1
    `;
    if (!out.length) return null;
    const r = out[0];
    return {
      ticker: r.ticker as string,
      price: Number(r.price),
      volume: r.volume == null ? null : Number(r.volume),
      tradedAt: new Date(r.traded_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Reference prices for a batch of tickers, one round-trip. Used by the paper
 * portfolio MARK/FILL steps (docs/council-paper-portfolios.md §4.2/§4.3), which
 * need every held-plus-candidate ticker's price at once rather than one at a
 * time. A ticker with no `live_prices` row is simply absent from the map —
 * callers must treat that as "no reference price this slot", not a zero.
 */
export async function getLivePrices(tickers: string[]): Promise<Map<string, number>> {
  if (tickers.length === 0) return new Map();
  try {
    const rows = await sql`
      SELECT ticker, price FROM live_prices WHERE ticker = ANY(${tickers}::text[])
    `;
    return new Map(rows.map((r) => [r.ticker as string, Number(r.price)]));
  } catch {
    return new Map();
  }
}

export interface PriceWithAge {
  price: number;
  tradedAt: string;
}

/**
 * Same lookup as `getLivePrices`, plus `traded_at` — the input to the paper
 * engine's price-freshness check (docs/paper-trading-v3.md §5.1.2, F7). A
 * fill made on a price that is hours old is indistinguishable from a fresh
 * one to `getLivePrices`'s callers, so the engine needs the timestamp to
 * decide whether to trust it. Rethrows on failure rather than degrading to an
 * empty map: the caller (paper-engine.ts) must be able to tell "no prices
 * exist yet" apart from "the price query itself is broken", per the F12 fix —
 * a swallowed error here previously looked identical to a quiet market.
 */
export async function getLivePricesWithAge(tickers: string[]): Promise<Map<string, PriceWithAge>> {
  if (tickers.length === 0) return new Map();
  const rows = await sql`
    SELECT ticker, price, traded_at FROM live_prices WHERE ticker = ANY(${tickers}::text[])
  `;
  return new Map(
    rows.map((r) => [
      r.ticker as string,
      { price: Number(r.price), tradedAt: new Date(r.traded_at as string).toISOString() },
    ]),
  );
}
