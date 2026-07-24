/**
 * live-price — pure parsing/validation for the real-time price feed pushed by
 * the Finnhub WebSocket tier (homebase/modal_finnhub_ws.py) to
 * POST /api/signals/live. No I/O here so it can be unit-tested without the DB.
 */
import { normalizeTicker } from "@/lib/shared/signal-policy";

export interface LivePrice {
  ticker: string;
  price: number;
  tradedAt: string; // ISO
  volume: number | null;
}

/** Validate one raw row from the WS worker. Returns null if unusable. */
export function parseLivePriceRow(raw: unknown): LivePrice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const ticker = normalizeTicker(r.ticker);
  if (!ticker) return null;

  const price = typeof r.price === "number" ? r.price : Number(r.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  // tradedAt may arrive as an ISO string or a millisecond epoch (Finnhub `t`).
  let tradedAt: string;
  if (typeof r.tradedAt === "number") {
    const d = new Date(r.tradedAt);
    if (Number.isNaN(d.getTime())) return null;
    tradedAt = d.toISOString();
  } else if (typeof r.tradedAt === "string") {
    const d = new Date(r.tradedAt);
    if (Number.isNaN(d.getTime())) return null;
    tradedAt = d.toISOString();
  } else {
    return null;
  }

  const volume =
    typeof r.volume === "number" && Number.isFinite(r.volume) && r.volume >= 0 ? Math.floor(r.volume) : null;

  return { ticker, price, tradedAt, volume };
}

/**
 * Parse a batch body `{ prices: [...] }`, keeping only the *latest* valid row
 * per ticker (WS feeds send many trades per symbol per second; we only persist
 * the freshest). Returns [] for anything malformed.
 */
export function parseLivePriceBatch(body: unknown): LivePrice[] {
  if (!body || typeof body !== "object") return [];
  const prices = (body as Record<string, unknown>).prices;
  if (!Array.isArray(prices)) return [];

  const latest = new Map<string, LivePrice>();
  for (const raw of prices) {
    const row = parseLivePriceRow(raw);
    if (!row) continue;
    const existing = latest.get(row.ticker);
    if (!existing || row.tradedAt >= existing.tradedAt) {
      latest.set(row.ticker, row);
    }
  }
  return [...latest.values()];
}
