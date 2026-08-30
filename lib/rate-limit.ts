/**
 * Minimal in-process sliding-window rate limiter.
 *
 * Deliberately dependency-free and in-memory: this app runs on Vercel
 * serverless where each instance is short-lived, so this is a per-instance
 * best-effort guard, not a distributed quota. It exists to stop a single
 * client hammering an expensive endpoint (the privacy DSAR routes assemble a
 * full cross-table export on every call) within one warm instance's lifetime.
 * A hard, cross-instance limit would need Redis/Upstash — out of scope until
 * there is a reason to add that dependency.
 *
 * Referenced by docs/todo-auth-cookies-tracking.md Phase 6 (rate-limit the
 * export endpoint).
 */

interface Window {
  hits: number[];
}

const buckets = new Map<string, Window>();

// Opportunistic cleanup so the Map cannot grow without bound on a long-lived
// instance. Runs at most once per this interval, on the next call after it.
const SWEEP_INTERVAL_MS = 5 * 60_000;
let lastSweep = 0;

function sweep(now: number, windowMs: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, win] of buckets) {
    win.hits = win.hits.filter((t) => now - t < windowMs);
    if (win.hits.length === 0) buckets.delete(key);
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Unix ms when the oldest in-window hit expires (i.e. when a slot frees). */
  resetAt: number;
}

/**
 * Record one hit for `key` and report whether it is within `limit` per
 * `windowMs`. Call once per request; the call itself counts as a hit only when
 * it is allowed (a rejected request does not consume a future slot).
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  sweep(now, windowMs);

  const win = buckets.get(key) ?? { hits: [] };
  win.hits = win.hits.filter((t) => now - t < windowMs);

  if (win.hits.length >= limit) {
    buckets.set(key, win);
    return {
      ok: false,
      remaining: 0,
      resetAt: win.hits[0] + windowMs,
    };
  }

  win.hits.push(now);
  buckets.set(key, win);
  return {
    ok: true,
    remaining: limit - win.hits.length,
    resetAt: win.hits[0] + windowMs,
  };
}

/** Test-only: drop all recorded state. */
export function __resetRateLimitState(): void {
  buckets.clear();
  lastSweep = 0;
}
