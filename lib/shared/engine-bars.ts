/**
 * Validation for daily bars pushed to /api/pipeline/daily-bars. Pure: rejects
 * a row with a reason rather than throwing, so one bad symbol cannot poison a
 * batch (same contract as hydrate-universe).
 */
export const MAX_BARS_PER_CALL = 20_000;
export const BAR_FEEDS = ["iex", "sip"] as const;
export const BAR_ADJUSTMENTS = ["split", "all", "raw"] as const;
export type BarFeed = (typeof BAR_FEEDS)[number];
export type BarAdjustment = (typeof BAR_ADJUSTMENTS)[number];

export interface BarRow {
  ticker: string;
  barDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());
}

/** Returns the row, or a rejection reason. OHLC must be finite, positive and self-consistent. */
export function validateBarRow(raw: unknown): BarRow | string {
  if (!raw || typeof raw !== "object") return "not an object";
  const r = raw as Record<string, unknown>;
  const ticker = typeof r.ticker === "string" ? r.ticker.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return "invalid ticker";
  if (!isIsoDate(r.barDate)) return "invalid barDate";
  const [open, high, low, close, volume] = [r.open, r.high, r.low, r.close, r.volume].map(Number);
  if (![open, high, low, close].every((n) => Number.isFinite(n) && n > 0)) return "non-positive or non-finite OHLC";
  if (!Number.isFinite(volume) || volume < 0) return "invalid volume";
  if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) return "inconsistent OHLC";
  return { ticker, barDate: r.barDate, open, high, low, close, volume };
}
