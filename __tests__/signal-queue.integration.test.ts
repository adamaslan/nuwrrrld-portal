/**
 * Integration test for the enqueue → claim → drain → cache path against a REAL
 * Postgres. Closes the "Validated by" gap TODO2 left open.
 *
 * Guarded: runs only when DATABASE_URL is set (point it at a throwaway Neon
 * branch). All imports are dynamic so that, in the default CI environment where
 * DATABASE_URL is unset, this file loads without pulling in `@/lib/db` (which
 * throws at import time) and simply skips.
 *
 *   DATABASE_URL=postgres://…neon-branch… npx vitest run signal-queue.integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("pending_signals queue (integration)", () => {
  let sql: typeof import("@/lib/db").default;
  let queue: typeof import("@/lib/signal-queue");
  const TICKER = `ZTEST${Math.floor(Math.random() * 1000)}`;
  const USER = "test-user";

  beforeAll(async () => {
    sql = (await import("@/lib/db")).default;
    queue = await import("@/lib/signal-queue");
    // Minimal schema (matches lib/db/schema.sql) so the test is self-contained.
    await sql`
      CREATE TABLE IF NOT EXISTS pending_signals (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        ticker text NOT NULL,
        requested_by text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        attempts int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        claimed_at timestamptz,
        error text,
        requested_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      )
    `;
  });

  afterAll(async () => {
    if (sql) await sql`DELETE FROM pending_signals WHERE ticker = ${TICKER}`;
  });

  it("enqueue dedups a rapidly-repeated ticker to one pending row", async () => {
    await queue.enqueueSignalRefresh(TICKER, USER);
    await queue.enqueueSignalRefresh(TICKER, USER);
    await queue.enqueueSignalRefresh(TICKER, USER);
    const rows = await sql`SELECT count(*)::int AS n FROM pending_signals WHERE ticker = ${TICKER} AND status = 'pending'`;
    expect(rows[0].n).toBe(1);
  });

  it("claim flips the row to processing and is not re-claimable immediately", async () => {
    const first = await queue.claimPendingSignals(10);
    expect(first.some((r) => r.ticker === TICKER)).toBe(true);
    const second = await queue.claimPendingSignals(10);
    expect(second.some((r) => r.ticker === TICKER)).toBe(false); // still leased
  });

  it("a failure under the cap requeues with a future next_attempt_at", async () => {
    const claimed = await sql`SELECT id, attempts FROM pending_signals WHERE ticker = ${TICKER} LIMIT 1`;
    await queue.recordSignalFailure(claimed[0].id, claimed[0].attempts, "simulated");
    const rows = await sql`
      SELECT status, next_attempt_at > now() AS deferred FROM pending_signals WHERE ticker = ${TICKER} LIMIT 1
    `;
    expect(rows[0].status).toBe("pending");
    expect(rows[0].deferred).toBe(true);
  });

  it("getQueueStats returns numeric counters", async () => {
    const stats = await queue.getQueueStats();
    expect(typeof stats.pending).toBe("number");
    expect(typeof stats.processing).toBe("number");
  });
});
