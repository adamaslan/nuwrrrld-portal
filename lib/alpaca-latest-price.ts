/**
 * alpaca-latest-price — last-trade price from Alpaca's market-data API. The
 * middle rung of the followed-tickers price chain (live_prices → Alpaca →
 * daily_bars). Read-only: it uses the paper-account data key and never touches
 * an order endpoint. Never throws; a failure returns null so the caller falls
 * through to the next source and logs why.
 */
import { ALPACA_FEED } from "@/lib/shared/hydration-constants";

const ALPACA_DATA_BASE = "https://data.alpaca.markets";
const REQUEST_TIMEOUT_MS = 15_000;

export interface AlpacaLastTrade {
  price: number;
  tradedAt: string;
}

/** Yahoo writes share classes with a hyphen (BRK-B); Alpaca uses a dot (BRK.B). */
export function toAlpacaSymbol(ticker: string): string {
  return ticker.replace(/-/g, ".");
}

interface LatestTradesResponse {
  trades?: Record<string, { p?: number; t?: string } | null>;
}

export async function fetchAlpacaLatestTrade(ticker: string): Promise<AlpacaLastTrade | null> {
  const keyId = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!keyId || !secret) {
    console.warn("[alpaca-latest] ALPACA_API_KEY / ALPACA_API_SECRET not set; skipping");
    return null;
  }

  const symbol = toAlpacaSymbol(ticker);
  const url =
    `${ALPACA_DATA_BASE}/v2/stocks/trades/latest` +
    `?symbols=${encodeURIComponent(symbol)}&feed=${ALPACA_FEED}`;

  try {
    const res = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": keyId,
        "APCA-API-SECRET-KEY": secret,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[alpaca-latest] ${ticker}: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as LatestTradesResponse;
    const trade = body.trades?.[symbol];
    const price = trade?.p ?? 0;
    if (!trade?.t || price <= 0) return null;
    return { price, tradedAt: trade.t };
  } catch (err) {
    console.warn(`[alpaca-latest] ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
