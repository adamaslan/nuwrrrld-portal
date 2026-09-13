/**
 * POST /api/pipeline/paper-portfolios — one run-loop slot, all eight accounts.
 *
 * docs/council-paper-portfolios.md §4/§6, Phase 3 of
 * docs/paper-portfolios-remaining-todo.md. Called four times a trading day by
 * .github/workflows/paper-portfolios.yml (Phase 4, not yet written) — this
 * route implements the deterministic loop itself, with no cron wiring yet.
 *
 * `?slot=` is required (`preopen|midday|preclose|settle`); `?account=` is
 * optional and restricts the run to one account, for a targeted rerun. Every
 * account (or the one named) is run independently — one account's failure
 * doesn't abort the others, matching every other multi-item pipeline route in
 * this repo (e.g. followed-tickers' per-pick loop).
 *
 * Auth: Bearer PAPER_CRON_SECRET — its own secret, not CRON_SECRET, since this
 * route writes real (paper) capital state across all eight accounts and
 * deserves an independent blast radius from the read-mostly tracking crons.
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { runAccountSlot, todayEasternDate, type RunResult } from "@/lib/paper-engine";
import { PAPER_ACCOUNTS, type PaperAccount } from "@/lib/shared/paper-policy";
import type { Slot } from "@/lib/paper-db";

export const maxDuration = 300;

const VALID_SLOTS: Slot[] = ["preopen", "midday", "preclose", "settle"];

function isValidSlot(value: string | null): value is Slot {
  return value != null && (VALID_SLOTS as string[]).includes(value);
}

function isValidAccount(value: string | null): value is PaperAccount {
  return value != null && (PAPER_ACCOUNTS as string[]).includes(value);
}

export async function POST(req: NextRequest) {
  const secret = process.env.PAPER_CRON_SECRET;
  if (!secret) {
    console.error("[paper-portfolios] CONFIG_ERROR: PAPER_CRON_SECRET is not set.");
    return NextResponse.json({ error: "PAPER_CRON_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const slotParam = searchParams.get("slot");
  if (!isValidSlot(slotParam)) {
    return NextResponse.json(
      { error: `invalid or missing ?slot= (expected one of ${VALID_SLOTS.join(", ")})` },
      { status: 400 },
    );
  }
  const accountParam = searchParams.get("account");
  if (accountParam != null && !isValidAccount(accountParam)) {
    return NextResponse.json({ error: `invalid ?account= "${accountParam}"` }, { status: 400 });
  }

  const tradeDate = todayEasternDate();
  const accounts: PaperAccount[] = accountParam ? [accountParam] : PAPER_ACCOUNTS;

  const results: RunResult[] = [];
  const errors: { account: PaperAccount; error: string }[] = [];

  for (const account of accounts) {
    try {
      results.push(await runAccountSlot(account, tradeDate, slotParam));
    } catch (err) {
      // One account's DB failure must not take the other seven down — same
      // per-item isolation as followed-tickers' per-pick loop.
      errors.push({ account, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const ordersTotal = results.reduce((n, r) => n + r.ordersN, 0);
  return NextResponse.json({
    ok: errors.length === 0,
    tradeDate,
    slot: slotParam,
    results,
    errors,
    meta: {
      accountsRun: results.length,
      accountsFailed: errors.length,
      ordersTotal,
    },
  });
}
