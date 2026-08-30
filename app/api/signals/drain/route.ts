/**
 * POST /api/signals/drain
 * Drains the pending_signals queue (lib/signal-queue.ts): fetches a fresh
 * per-ticker entry from gcp3 for each queued ticker and upserts it into
 * signal_cache. Intended to be called by an external scheduled job (Modal/Zo
 * cron, outside this repo) — see TODO.md/TODO2.md "deferred" — but is safe to
 * call from anywhere holding PORTAL_PUSH_SECRET.
 *
 * Auth: Bearer PORTAL_PUSH_SECRET (server-to-server, not user-facing) —
 * same pattern as /api/signals/refresh.
 *
 * TODO2 hardening: a per-request time budget caps how long one drain runs so
 * it can't exceed the serverless wall clock, failures retry under a cap
 * instead of dying permanently, and terminal rows are purged opportunistically.
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { fetchTickerEntry, saveTickerEntry, normalizeTicker } from "@/lib/shared/signal-lookup";
import {
  claimPendingSignals,
  markSignalDone,
  recordSignalFailure,
  countPendingSignals,
  purgePendingSignals,
  getQueueStats,
  shouldRetry,
} from "@/lib/signal-queue";

const BATCH_SIZE = 8;
const TIME_BUDGET_MS = 25_000; // stay well under typical serverless limits
const PURGE_AFTER_DAYS = 7;

function checkAuth(req: NextRequest): NextResponse | null {
  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    console.error("[signals/drain] CONFIG_ERROR: PORTAL_PUSH_SECRET is not set.");
    return NextResponse.json({ error: "PORTAL_PUSH_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const authError = checkAuth(req);
  if (authError) return authError;

  const startedAt = Date.now();
  const pending = await claimPendingSignals(BATCH_SIZE);
  let done = 0;
  let retried = 0;
  let failed = 0;

  // A failure at `attempts` requeues (retry) unless it was the last allowed try.
  const tallyFailure = (attempts: number) => {
    if (shouldRetry(attempts + 1)) retried++;
    else failed++;
  };

  for (const row of pending) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break; // leave the rest for the next drain

    const symbol = normalizeTicker(row.ticker);
    if (!symbol) {
      await recordSignalFailure(row.id, row.attempts, "invalid ticker");
      tallyFailure(row.attempts);
      continue;
    }

    try {
      const entry = await fetchTickerEntry(symbol);
      if (!entry) {
        await recordSignalFailure(row.id, row.attempts, "no entry returned from backend");
        tallyFailure(row.attempts);
        continue;
      }
      // fetchTickerEntry already warms signal_cache on a live hit, but the
      // cache-hit path returns without writing — upsert explicitly so a queued
      // ticker is always freshened.
      await saveTickerEntry(symbol, entry);
      await markSignalDone(row.id);
      done++;
    } catch (err) {
      await recordSignalFailure(row.id, row.attempts, err instanceof Error ? err.message : "unknown error");
      tallyFailure(row.attempts);
    }
  }

  await purgePendingSignals(PURGE_AFTER_DAYS);

  const remaining = await countPendingSignals().catch(() => null);
  console.log(
    `[signals/drain] claimed=${pending.length} done=${done} retried=${retried} failed=${failed} remaining=${remaining} ms=${Date.now() - startedAt}`,
  );
  return NextResponse.json({ claimed: pending.length, done, retried, failed, remaining });
}

export async function GET() {
  try {
    const stats = await getQueueStats();
    return NextResponse.json(stats);
  } catch {
    return NextResponse.json({ error: "queue unavailable" }, { status: 503 });
  }
}
