/**
 * pending_signals queue — the enqueue side of the "add stock → cache → run
 * signals" loop. A watchlist add writes a row here; an external scheduled job
 * (Modal/Zo cron, outside this repo) drains it via POST /api/signals/drain.
 *
 * Enqueue failure must never block the watchlist add itself — this is a
 * best-effort trigger, not primary user data (see docs/wiki-portal
 * concept-cache-then-degrade.md for the cache-vs-user-data distinction).
 *
 * TODO2 hardening: enqueue dedups against existing pending rows, and the
 * drain path retries transient failures up to MAX_ATTEMPTS before giving up.
 */
import sql from "@/lib/db";
import { backoffSeconds, normalizeTicker, shouldRetry } from "@/lib/shared/signal-policy";

// Re-export so the drain route can keep importing retry policy from here.
export { MAX_ATTEMPTS, shouldRetry } from "@/lib/shared/signal-policy";

// How long a `processing` row may be leased before another drain may reclaim it
// (crash recovery). Comfortably longer than the drain time budget (25 s) plus a
// per-ticker fetch timeout, so a healthy drain never has its own rows stolen.
export const STALE_LEASE_SECONDS = 120;

/**
 * Enqueue a refresh for `ticker`, unless it is malformed or already pending.
 * Best-effort: any DB error is swallowed so the caller (watchlist add) is never
 * blocked. The `WHERE NOT EXISTS` guard means N rapid adds of the same ticker
 * collapse to a single pending row → a single backend fetch at drain time.
 */
export async function enqueueSignalRefresh(ticker: string, userId: string): Promise<void> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return;
  try {
    await sql`
      INSERT INTO pending_signals (ticker, requested_by)
      SELECT ${symbol}, ${userId}
      WHERE NOT EXISTS (
        SELECT 1 FROM pending_signals WHERE ticker = ${symbol} AND status = 'pending'
      )
    `;
  } catch {
    // non-fatal — the ticker just won't get a proactive refresh; the next
    // organic /signals?symbol= lookup or scheduled full-universe run will
    // still pick it up eventually.
  }
}

export interface PendingSignal {
  id: number;
  ticker: string;
  attempts: number;
}

/**
 * Atomically claim up to `limit` due rows, flipping them `pending → processing`
 * in a single statement so two concurrent drains never grab the same ticker
 * (`FOR UPDATE SKIP LOCKED`). "Due" means a pending row whose backoff has
 * elapsed (`next_attempt_at <= now()`), OR a `processing` row whose lease has
 * expired — the latter recovers rows orphaned by a crashed drain.
 */
export async function claimPendingSignals(limit: number): Promise<PendingSignal[]> {
  const rows = await sql`
    UPDATE pending_signals p
    SET status = 'processing', claimed_at = now()
    FROM (
      SELECT id FROM pending_signals
      WHERE (status = 'pending' AND next_attempt_at <= now())
         OR (status = 'processing' AND claimed_at < now() - (${STALE_LEASE_SECONDS} * interval '1 second'))
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    ) claimed
    WHERE p.id = claimed.id
    RETURNING p.id, p.ticker, p.attempts
  `;
  return rows.map((r) => ({
    id: r.id as number,
    ticker: r.ticker as string,
    attempts: (r.attempts as number) ?? 0,
  }));
}

export async function markSignalDone(id: number): Promise<void> {
  await sql`
    UPDATE pending_signals
    SET status = 'done', processed_at = now(), claimed_at = NULL
    WHERE id = ${id}
  `;
}

/**
 * Record a failed attempt. If retries remain the row goes back to 'pending'
 * with an exponential backoff delay (a transient gcp3 blip recovers on a later
 * drain, without hammering); once the cap is hit it becomes a terminal 'error'.
 */
export async function recordSignalFailure(id: number, attempts: number, error: string): Promise<void> {
  const nextAttempts = attempts + 1;
  if (shouldRetry(nextAttempts)) {
    const delay = backoffSeconds(nextAttempts);
    await sql`
      UPDATE pending_signals
      SET status = 'pending',
          attempts = ${nextAttempts},
          error = ${error},
          next_attempt_at = now() + (${delay} * interval '1 second'),
          claimed_at = NULL
      WHERE id = ${id}
    `;
    return;
  }
  // Cap hit — terminal error.
  await sql`
    UPDATE pending_signals
    SET status = 'error', attempts = ${nextAttempts}, error = ${error}, processed_at = now(), claimed_at = NULL
    WHERE id = ${id}
  `;
}

export async function countPendingSignals(): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM pending_signals WHERE status = 'pending'`;
  return (rows[0]?.n as number) ?? 0;
}

export interface QueueStats {
  pending: number;
  processing: number;
  done: number;
  error: number;
  oldestPendingAgeSeconds: number | null;
  errorRate: number | null; // error / (error + done) over surviving rows; null when none terminal
}

/** One-query snapshot for the drain healthcheck. */
export async function getQueueStats(): Promise<QueueStats> {
  const rows = await sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int    AS pending,
      count(*) FILTER (WHERE status = 'processing')::int AS processing,
      count(*) FILTER (WHERE status = 'done')::int       AS done,
      count(*) FILTER (WHERE status = 'error')::int      AS error,
      EXTRACT(EPOCH FROM (now() - min(requested_at) FILTER (WHERE status = 'pending')))::int AS oldest_pending_age_s
    FROM pending_signals
  `;
  const r = rows[0] ?? {};
  const done = (r.done as number) ?? 0;
  const error = (r.error as number) ?? 0;
  const terminal = done + error;
  return {
    pending: (r.pending as number) ?? 0,
    processing: (r.processing as number) ?? 0,
    done,
    error,
    oldestPendingAgeSeconds: (r.oldest_pending_age_s as number) ?? null,
    errorRate: terminal > 0 ? error / terminal : null,
  };
}

/** Delete terminal (done/error) rows older than `olderThanDays`. Best-effort. */
export async function purgePendingSignals(olderThanDays: number): Promise<void> {
  try {
    await sql`
      DELETE FROM pending_signals
      WHERE status IN ('done', 'error')
        AND processed_at < now() - (${olderThanDays} * interval '1 day')
    `;
  } catch {
    // non-fatal — hygiene only; rows accumulating never breaks the loop.
  }
}
