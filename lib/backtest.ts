/**
 * Backtest engine client — fetches historical hit-rate data from the
 * (separate) signals-app FastAPI backend. This is a different engine than
 * the gcp3 backend that powers the live signal digest (see lib/digest.ts);
 * the two are not otherwise connected.
 *
 * Disabled by default: SIGNALS_ENGINE_URL must be set to a live backtest
 * engine base URL, or all calls return null. We never hardcode a URL we
 * haven't confirmed is live.
 */

const SIGNALS_ENGINE_URL = (process.env.SIGNALS_ENGINE_URL ?? "").replace(/\/$/, "");
const TIMEOUT_MS = 8_000;

export interface BacktestBucket {
  key: string;
  hits: number;
  total: number;
  hit_rate: number;
}

export interface BacktestResult {
  symbol: string;
  period: string;
  horizon_days: number;
  bars_scanned: number;
  by_category: BacktestBucket[];
  by_strength: BacktestBucket[];
}

function isBacktestBucket(value: unknown): value is BacktestBucket {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.key === "string" &&
    typeof b.hits === "number" && Number.isInteger(b.hits) && b.hits >= 0 &&
    typeof b.total === "number" && Number.isInteger(b.total) && b.total >= 0 &&
    b.hits <= b.total &&
    typeof b.hit_rate === "number" && Number.isFinite(b.hit_rate) &&
    b.hit_rate >= 0 && b.hit_rate <= 1
  );
}

function isBacktestResult(value: unknown): value is BacktestResult {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return typeof r.period === "string" && r.period.trim().length > 0
    && typeof r.horizon_days === "number" && Number.isInteger(r.horizon_days) && r.horizon_days > 0
    && typeof r.bars_scanned === "number" && Number.isInteger(r.bars_scanned) && r.bars_scanned >= 0
    && Array.isArray(r.by_category) && r.by_category.every(isBacktestBucket)
    && Array.isArray(r.by_strength) && r.by_strength.every(isBacktestBucket);
}

/**
 * Fetch historical hit-rate backtest data for a symbol.
 * Returns null on any failure (disabled, timeout, non-2xx, bad JSON, or a
 * response that doesn't match BacktestResult's shape) — this is a
 * nice-to-have enhancement and must never crash the page it's used on.
 */
export async function fetchBacktest(symbol: string): Promise<BacktestResult | null> {
  if (!SIGNALS_ENGINE_URL) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${SIGNALS_ENGINE_URL}/backtest/${encodeURIComponent(symbol)}?period=2y`,
      { signal: controller.signal },
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!isBacktestResult(data) || data.symbol !== symbol) return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
