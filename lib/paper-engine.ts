/**
 * paper-engine — the deterministic run loop for one (account, trade_date, slot)
 * (docs/council-paper-portfolios.md §4.2, Phase 3 of
 * docs/paper-portfolios-remaining-todo.md).
 *
 * Implements steps 1–5 and 7–9: LOAD, MARK, SCREEN, RANK, PROPOSE, CLIP, FILL,
 * PERSIST. Step 6 (ARBITRATE) doesn't exist yet — every candidate that would
 * reach it falls through as CONFIRM-none, i.e. `model_calls` is always 0 and
 * `decided_by` is always `'rule'` for every order this module writes (Phase 5
 * adds the model layer between RANK/PROPOSE and CLIP, not here).
 *
 * RANK/PROPOSE/CLIP/FILL are pure functions in lib/shared/paper-engine-core.ts;
 * this module is the I/O shell — load state, screen candidates, call the pure
 * planner, persist the result in one transaction. Same split as every other
 * pipeline route in this repo (e.g. app/api/pipeline/followed-tickers/route.ts
 * calling into lib/shared/followed-tickers-policy.ts).
 *
 * Idempotency (§4.4): the run row's id is generated client-side and inserted
 * with `ON CONFLICT (account, trade_date, slot) DO NOTHING`. Every order this
 * run writes FK-references that same id. If another caller already ran this
 * exact slot, our run row is silently not inserted (DO NOTHING), our orders'
 * `run_id` then points at a row that was never created, and the FK constraint
 * aborts the *entire* transaction — so a race loses cleanly, writing nothing,
 * rather than double-filling. The catch block below turns that abort into a
 * "return the existing run" response instead of a 500.
 */
import { randomUUID } from "node:crypto";
import sql from "@/lib/db";
import { latestCardBarDate } from "@/lib/ticker-cards-db";
import { getLivePrices } from "@/lib/live-price-db";
import {
  getAccount,
  getPositions,
  getRun,
  listActiveWatchlist,
  getScreenCandidates,
  type Slot,
  type RunStatus,
} from "@/lib/paper-db";
import {
  isTradingAccount,
  policyFor,
  type PaperAccount,
} from "@/lib/shared/paper-policy";
import {
  planRun,
  fillOrders,
  type EngineCandidate,
  type EnginePosition,
} from "@/lib/shared/paper-engine-core";
import type { Horizon } from "@/lib/grounding/taxonomy";

export interface RunResult {
  account: PaperAccount;
  tradeDate: string;
  slot: Slot;
  status: RunStatus;
  skipReason: string | null;
  candidatesN: number;
  ordersN: number;
  /** True when this call found an existing run row instead of doing work —
   *  either the fast-path getRun() check, or the FK-abort recovery path. */
  alreadyRan: boolean;
}

/** Which ticker_cards.horizon rows an account's `cardHorizon` reads. */
function horizonsFor(cardHorizon: "t1" | "t2" | "both"): Horizon[] {
  return cardHorizon === "both" ? ["t1", "t2"] : [cardHorizon];
}

/** Reduce possibly-two-horizon screen rows to one score per ticker. For
 *  `'both'` accounts (quant, chair) this takes the higher of the two —
 *  documented simplification (module doc header) rather than a designed
 *  blending function, since §3 doesn't specify one. */
function reduceToScorePerTicker(rows: { ticker: string; score: number }[]): EngineCandidate[] {
  const best = new Map<string, number>();
  for (const r of rows) {
    const cur = best.get(r.ticker);
    if (cur == null || r.score > cur) best.set(r.ticker, r.score);
  }
  return [...best.entries()].map(([ticker, score]) => ({ ticker, score }));
}

/**
 * Run one account for one slot. Never throws for expected conditions (no
 * policy, market closed, already run) — those come back as a `RunResult`.
 * Only an unexpected DB failure outside the idempotency-recovery path throws.
 */
export async function runAccountSlot(
  account: PaperAccount,
  tradeDate: string,
  slot: Slot,
): Promise<RunResult> {
  const existing = await getRun(account, tradeDate, slot);
  if (existing) {
    return {
      account,
      tradeDate,
      slot,
      status: existing.status,
      skipReason: existing.skipReason,
      candidatesN: existing.candidatesN ?? 0,
      ordersN: existing.ordersN ?? 0,
      alreadyRan: true,
    };
  }

  const runId = randomUUID();
  const dbAccount = await getAccount(account);
  if (!dbAccount) {
    // Not seeded yet — record nothing (there is no paper_accounts FK target
    // to hang a run row on), just report it.
    return {
      account,
      tradeDate,
      slot,
      status: "failed",
      skipReason: "account_not_seeded",
      candidatesN: 0,
      ordersN: 0,
      alreadyRan: false,
    };
  }

  const barDate = await latestCardBarDate();
  const positions = await getPositions(account);
  const watchlist = await listActiveWatchlist(account);
  const activeWatchlist = new Set(watchlist.map((w) => w.ticker));

  // equal/spy never trade — mark-to-market only, every slot, forever (§2.1's
  // "equal" and "spy" controls). A trading account also does no trading on
  // the settle slot (§4.1 — settle is mark-to-market + metrics only).
  const policy = policyFor(account);
  const tradingSlot = isTradingAccount(account) && slot !== "settle";

  if (!barDate) {
    return persistSkippedRun(runId, account, tradeDate, slot, dbAccount.policyVersion, "market_closed");
  }

  const allTickers = [...new Set([...positions.map((p) => p.ticker), ...activeWatchlist])];
  const prices = await getLivePrices(allTickers);

  // MARK — update each held position's high-water mark against this slot's
  // reference price before CLIP reads it for the trailing-stop check.
  const markedPositions: EnginePosition[] = positions.map((p) => {
    const price = prices.get(p.ticker) ?? p.avgCost;
    return {
      ticker: p.ticker,
      quantity: p.quantity,
      avgCost: p.avgCost,
      runsHeld: p.runsHeld + 1,
      highWater: Math.max(p.highWater, price),
    };
  });

  const positionsMv = markedPositions.reduce(
    (sum, p) => sum + p.quantity * (prices.get(p.ticker) ?? p.avgCost),
    0,
  );
  const nav = dbAccount.cash + positionsMv;

  let candidates: EngineCandidate[] = [];
  if (tradingSlot && policy) {
    const horizons = horizonsFor(policy.cardHorizon);
    const screenRows = await getScreenCandidates(account, horizons, policy.dataQualityGate, barDate);
    candidates = reduceToScorePerTicker(screenRows);
  }

  const plan =
    tradingSlot && policy
      ? planRun({
          policy,
          nav,
          cash: dbAccount.cash,
          positions: markedPositions,
          candidates,
          activeWatchlist,
          prices: Object.fromEntries(prices),
        })
      : { orders: [], turnoverUsed: 0 };

  const avgCostByTicker = new Map(markedPositions.map((p) => [p.ticker, p.avgCost]));
  const filled = fillOrders(plan.orders, avgCostByTicker);
  const cardScoreByTicker = new Map(candidates.map((c) => [c.ticker, c.score]));

  // Apply fills to the in-memory book so PERSIST writes the post-run state.
  const finalPositions = new Map(markedPositions.map((p) => [p.ticker, { ...p }]));
  let finalCash = dbAccount.cash;
  const deletedTickers = new Set<string>();
  for (const o of filled) {
    if (o.side === "sell") {
      finalCash += o.notional;
      finalPositions.delete(o.ticker);
      deletedTickers.add(o.ticker);
    } else {
      finalCash -= o.notional;
      const existingPos = finalPositions.get(o.ticker);
      if (existingPos) {
        existingPos.avgCost =
          (existingPos.avgCost * existingPos.quantity + o.notional) / (existingPos.quantity + o.quantity);
        existingPos.quantity += o.quantity;
      } else {
        finalPositions.set(o.ticker, {
          ticker: o.ticker,
          quantity: o.quantity,
          avgCost: o.fillPrice,
          runsHeld: 0,
          highWater: o.fillPrice,
        });
      }
    }
  }
  const finalPositionsMv = [...finalPositions.values()].reduce(
    (sum, p) => sum + p.quantity * (prices.get(p.ticker) ?? p.avgCost),
    0,
  );
  const finalNav = finalCash + finalPositionsMv;
  const dayReturn = nav > 0 ? finalNav / nav - 1 : null;
  const totalReturn = dbAccount.startingCash > 0 ? finalNav / dbAccount.startingCash - 1 : null;

  const queries = [
    sql`
      INSERT INTO paper_runs
        (id, account, trade_date, slot, status, skip_reason, candidates_n, orders_n,
         model_calls, policy_version, detail, finished_at)
      VALUES (
        ${runId}, ${account}, ${tradeDate}, ${slot}, 'ok', null, ${candidates.length},
        ${filled.length}, 0, ${dbAccount.policyVersion}, ${JSON.stringify({ turnoverUsed: plan.turnoverUsed })}, now()
      )
      ON CONFLICT (account, trade_date, slot) DO NOTHING
    `,
    ...filled.map(
      (o) => sql`
        INSERT INTO paper_orders
          (id, run_id, account, ticker, side, quantity, ref_price, fill_price,
           slippage_bps, notional, realized_pnl, reason, decided_by, model, card_score)
        VALUES (
          ${randomUUID()}, ${runId}, ${account}, ${o.ticker}, ${o.side}, ${o.quantity},
          ${o.refPrice}, ${o.fillPrice}, ${o.slippageBps}, ${o.notional}, ${o.realizedPnl},
          ${o.reason}, 'rule', null, ${cardScoreByTicker.get(o.ticker) ?? null}
        )
      `,
    ),
    ...[...finalPositions.values()].map(
      (p) => sql`
        INSERT INTO paper_positions
          (account, ticker, quantity, avg_cost, opened_at, last_trade_at, runs_held, high_water)
        VALUES (${account}, ${p.ticker}, ${p.quantity}, ${p.avgCost}, now(), now(), ${p.runsHeld}, ${p.highWater})
        ON CONFLICT (account, ticker) DO UPDATE SET
          quantity      = EXCLUDED.quantity,
          avg_cost      = EXCLUDED.avg_cost,
          last_trade_at = now(),
          runs_held     = EXCLUDED.runs_held,
          high_water    = EXCLUDED.high_water
      `,
    ),
    ...[...deletedTickers].map(
      (ticker) => sql`DELETE FROM paper_positions WHERE account = ${account} AND ticker = ${ticker}`,
    ),
    sql`UPDATE paper_accounts SET cash = ${finalCash}, updated_at = now() WHERE account = ${account}`,
    sql`
      INSERT INTO paper_nav
        (account, trade_date, slot, cash, positions_mv, nav, day_return, total_return, positions_n, turnover)
      VALUES (
        ${account}, ${tradeDate}, ${slot}, ${finalCash}, ${finalPositionsMv}, ${finalNav},
        ${dayReturn}, ${totalReturn}, ${finalPositions.size}, ${plan.turnoverUsed}
      )
      ON CONFLICT (account, trade_date, slot) DO UPDATE SET
        cash         = EXCLUDED.cash,
        positions_mv = EXCLUDED.positions_mv,
        nav          = EXCLUDED.nav,
        day_return   = EXCLUDED.day_return,
        total_return = EXCLUDED.total_return,
        positions_n  = EXCLUDED.positions_n,
        turnover     = EXCLUDED.turnover
    `,
  ];

  try {
    await sql.transaction(queries);
  } catch (err) {
    // Most likely cause: another caller already inserted the run row for this
    // exact slot, so our paper_orders' run_id FK has nothing to point at and
    // Postgres aborted the whole transaction — see module doc above. Confirm
    // by re-reading; a genuine unrelated failure still has no run row to find
    // and rethrows instead of masking a real error as "already ran".
    const winner = await getRun(account, tradeDate, slot);
    if (winner) {
      return {
        account,
        tradeDate,
        slot,
        status: winner.status,
        skipReason: winner.skipReason,
        candidatesN: winner.candidatesN ?? 0,
        ordersN: winner.ordersN ?? 0,
        alreadyRan: true,
      };
    }
    throw err;
  }

  return {
    account,
    tradeDate,
    slot,
    status: "ok",
    skipReason: null,
    candidatesN: candidates.length,
    ordersN: filled.length,
    alreadyRan: false,
  };
}

async function persistSkippedRun(
  runId: string,
  account: PaperAccount,
  tradeDate: string,
  slot: Slot,
  policyVersion: string,
  skipReason: string,
): Promise<RunResult> {
  try {
    await sql`
      INSERT INTO paper_runs
        (id, account, trade_date, slot, status, skip_reason, candidates_n, orders_n,
         model_calls, policy_version, detail, finished_at)
      VALUES (${runId}, ${account}, ${tradeDate}, ${slot}, 'skipped', ${skipReason}, 0, 0, 0, ${policyVersion}, '{}'::jsonb, now())
      ON CONFLICT (account, trade_date, slot) DO NOTHING
    `;
  } catch (err) {
    console.error(`[paper-engine] failed to persist skipped run for ${account}/${slot}: ${err}`);
  }
  const row = await getRun(account, tradeDate, slot);
  return {
    account,
    tradeDate,
    slot,
    status: row?.status ?? "skipped",
    skipReason: row?.skipReason ?? skipReason,
    candidatesN: 0,
    ordersN: 0,
    alreadyRan: false,
  };
}

/** Today's calendar date in US/Eastern, `YYYY-MM-DD` — the `trade_date` every
 *  slot for "today" is keyed on (§4.1's cadence is defined in ET). */
export function todayEasternDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}
