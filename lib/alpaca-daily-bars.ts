/**
 * alpaca-daily-bars — completed daily closes from Alpaca's market-data API
 * (`/v2/stocks/bars`, SIP feed, split-adjusted). Read-only: it uses the
 * paper-account data key and never touches an order endpoint.
 *
 * The followed-tickers observer runs ~7–8 PM ET, before the nightly `daily_bars`
 * hydration has written that day's row, and IEX rarely prints after 16:00 ET, so
 * neither of the other rungs can supply the day's close at that hour. A SIP daily
 * bar is the session's official close and is available immediately after it.
 *
 * Never throws: a failure returns an empty map so the caller falls through and
 * logs why.
 */
const ALPACA_DATA_BASE = "https://data.alpaca.markets";
const REQUEST_TIMEOUT_MS = 20_000;
/** Symbols per request; Alpaca accepts far more, this keeps each page small. */
const SYMBOLS_PER_REQUEST = 100;
const MAX_PAGES = 20;
/** The Basic plan serves SIP only for data at least 15 minutes old. */
const SIP_DELAY_MS = 16 * 60_000;
const BARS_FEED = "sip";
const BARS_ADJUSTMENT = "split";

export interface DailyBar {
  /** Session date (YYYY-MM-DD, New York). */
  date: string;
  close: number;
}

interface BarsResponse {
  bars?: Record<string, Array<{ t?: string; c?: number }> | null>;
  next_page_token?: string | null;
}

/** Yahoo writes share classes with a hyphen (BRK-B); Alpaca uses a dot (BRK.B). */
function toAlpacaSymbol(ticker: string): string {
  return ticker.replace(/-/g, ".");
}

/**
 * Daily closes for `tickers` over `[startDate, endDate]` (inclusive YYYY-MM-DD),
 * oldest first per ticker. Tickers Alpaca has no bars for are simply absent.
 */
export async function fetchAlpacaDailyBars(
  tickers: readonly string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, DailyBar[]>> {
  const out = new Map<string, DailyBar[]>();
  const keyId = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!keyId || !secret) {
    console.warn("[alpaca-bars] ALPACA_API_KEY / ALPACA_API_SECRET not set; skipping");
    return out;
  }

  const bySymbol = new Map(tickers.map((t) => [toAlpacaSymbol(t), t]));
  const symbols = [...bySymbol.keys()];
  // `end` must be at least 15 minutes old for SIP; midnight after endDate is
  // usually in the future, so clamp it to now minus the delay.
  const endOfDay = new Date(`${endDate}T23:59:59Z`).getTime();
  const end = new Date(Math.min(endOfDay, Date.now() - SIP_DELAY_MS)).toISOString();

  try {
    for (let i = 0; i < symbols.length; i += SYMBOLS_PER_REQUEST) {
      const chunk = symbols.slice(i, i + SYMBOLS_PER_REQUEST);
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams({
          symbols: chunk.join(","),
          timeframe: "1Day",
          start: `${startDate}T00:00:00Z`,
          end,
          adjustment: BARS_ADJUSTMENT,
          feed: BARS_FEED,
          limit: "10000",
        });
        if (pageToken) params.set("page_token", pageToken);
        const res = await fetch(`${ALPACA_DATA_BASE}/v2/stocks/bars?${params}`, {
          headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret },
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          console.warn(`[alpaca-bars] HTTP ${res.status} for ${chunk.length} symbols; skipping chunk`);
          break;
        }
        const body = (await res.json()) as BarsResponse;
        for (const [symbol, bars] of Object.entries(body.bars ?? {})) {
          const ticker = bySymbol.get(symbol);
          if (!ticker || !bars) continue;
          const rows = out.get(ticker) ?? [];
          for (const b of bars) {
            if (!b.t || !b.c || b.c <= 0) continue;
            rows.push({ date: b.t.slice(0, 10), close: b.c });
          }
          out.set(ticker, rows);
        }
        pageToken = body.next_page_token ?? null;
        if (!pageToken) break;
      }
    }
  } catch (err) {
    console.warn(`[alpaca-bars] ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/** The close of one ticker's session on `date`, or null. */
export async function fetchAlpacaCloseOn(
  ticker: string,
  date: string,
): Promise<number | null> {
  const bars = await fetchAlpacaDailyBars([ticker], date, date);
  return bars.get(ticker)?.find((b) => b.date === date)?.close ?? null;
}
