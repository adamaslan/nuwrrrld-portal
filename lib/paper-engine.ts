/**
 * paper-engine — the deterministic run loop for one (account, trade_date, slot)
 * (docs/council-paper-portfolios.md §4.2, Phase 3 of
 * docs/paper-portfolios-remaining-todo.md).
 *
 * Implements steps 1–9: LOAD, MARK, SCREEN, RANK, PROPOSE, ARBITRATE, CLIP,
 * FILL, PERSIST. ARBITRATE (Phase 5) is applied after CLIP rather than
 * before it — see the module doc on `selectArbitrationCandidates` in
 * lib/shared/paper-engine-core.ts for why that ordering is still faithful to
 * §4.2's guardrails. QUANT makes zero model calls by construction
 * (`policy.maxModelCallsPerRun === 0`) and never reaches arbitration.
 *
 * Also mirrors the run to Firestore (Phase 6, non-fatal — a mirror failure
 * never fails the run, guardrail #7) and, on the `settle` slot only, runs the
 * Neon-vs-Firestore drift check and computes §7's account metrics (Phase 8,
 * lib/paper-metrics.ts, same non-fatal contract). All three live outside this
 * module; it just calls them after its own transaction has committed and
 * records the outcome into `paper_runs.detail`.
 *
 * RANK/PROPOSE/CLIP/FILL/ARBITRATE's pure half are in
 * lib/shared/paper-engine-core.ts; this module is the I/O shell — load state,
 * screen candidates, call the pure planner, make the arbitration model calls,
 * persist the result in one transaction, then mirror. Same split as every
 * other pipeline route in this repo (e.g.
 * app/api/pipeline/followed-tickers/route.ts calling into
 * lib/shared/followed-tickers-policy.ts).
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
import { getLivePricesWithAge } from "@/lib/live-price-db";
import {
  getAccount,
  getPositions,
  getRun,
  listActiveWatchlist,
  getScreenCandidates,
  getSeatOrdersForSlot,
  getRecentlyStoppedTickers,
  updateRunDetail,
  countOrders,
  type Slot,
  type RunStatus,
  type OrderRow,
} from "@/lib/paper-db";
import {
  isTradingAccount,
  policyFor,
  ACCOUNT_SEAT,
  PAPER_POLICY_VERSION,
  TRADING_ACCOUNTS,
  type PaperAccount,
  type PaperPolicy,
  type TradingAccount,
} from "@/lib/shared/paper-policy";
import {
  planRun,
  planChairConsensus,
  stopCooldownStart,
  fillOrders,
  selectArbitrationCandidates,
  applyArbitrationResults,
  type EngineCandidate,
  type EnginePosition,
  type ArbitrationResult,
  type ConsensusVote,
} from "@/lib/shared/paper-engine-core";
import { buildTieBreak } from "@/lib/shared/paper-persona";
import { coreBookFor } from "@/lib/shared/paper-core-books";
import { arbitrateOne } from "@/lib/paper-arbitration";
import { mirrorPaperAccount, mirrorWatchlistIfVersionChanged } from "@/lib/paper-firestore-mirror";
import { reconcileAccount } from "@/lib/paper-reconcile";
import { computeMetricsForAccount } from "@/lib/paper-metrics";
import type { Horizon } from "@/lib/grounding/taxonomy";

/** A reference price older than this is not trusted for a fill
 *  (docs/paper-trading-v3.md F7/§5.1.2). 30 minutes for the four trading
 *  slots — long enough to absorb the price-push step's own latency, short
 *  enough that a genuinely stale feed (a missed refresh, a dead cron) is
 *  caught before it fills at yesterday's number. Settle never trades, so it
 *  has no analogous risk and is not gated by this at all. */
const MAX_PRICE_AGE_MINUTES = 30;

/** Shared, mutable across every account in one route call — the
 *  ≤36-calls-per-run-across-all-accounts ceiling (§4.2) has to be enforced
 *  across the whole loop in app/api/pipeline/paper-portfolios/route.ts, not
 *  per account, so the route passes the same object into every
 *  `runAccountSlot` call and each call decrements it as it spends. */
export interface ModelCallBudget {
  remaining: number;
}

export interface RunAccountSlotOptions {
  /** OPENROUTER_API_KEY. Arbitration is skipped entirely when absent —
   *  degrades to deterministic-only rather than failing (guardrail #4). */
  apiKey?: string;
  globalBudget?: ModelCallBudget;
  /** Set by the caller (app/api/pipeline/paper-portfolios/route.ts's `?late=`)
   *  when this slot is starting well past its intended window
   *  (docs/paper-trading-v3.md F6/§5.2). Recorded on the run's detail;
   *  see this option's own doc on the route for what it does and doesn't
   *  change about trading behavior yet. */
  late?: boolean;
}

export interface RunResult {
  account: PaperAccount;
  tradeDate: string;
  slot: Slot;
  status: RunStatus;
  skipReason: string | null;
  candidatesN: number;
  ordersN: number;
  modelCalls: number;
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
 *  blending function, since §3 doesn't specify one. Carries the winning row's
 *  tokens/dataQuality along too, so persona tie-breaks (lib/shared/paper-persona.ts)
 *  have something to read beyond the bare score. */
function reduceToScorePerTicker(
  rows: { ticker: string; score: number; dataQuality: number; tokens: Record<string, string> }[],
): EngineCandidate[] {
  const best = new Map<string, { score: number; dataQuality: number; tokens: Record<string, string> }>();
  for (const r of rows) {
    const cur = best.get(r.ticker);
    if (cur == null || r.score > cur.score) {
      best.set(r.ticker, { score: r.score, dataQuality: r.dataQuality, tokens: r.tokens });
    }
  }
  return [...best.entries()].map(([ticker, v]) => ({ ticker, ...v }));
}

/**
 * Deterministic trade-ticket text (docs/paper-trading-v3.md §4.1) — no model
 * call, built entirely from the card tokens, the score, and the account's own
 * policy. Written once per buy onto `paper_positions.thesis`/`invalidation`
 * so an open position always carries *why* it was opened and *what* would
 * change that, instead of the two columns sitting NULL forever (F9).
 */
function ticketText(
  ticker: string,
  score: number | undefined,
  tokens: Record<string, string> | undefined,
  policy: PaperPolicy,
): { thesis: string; invalidation: string } {
  const why =
    score == null || !tokens
      ? `card score ${score ?? "n/a"}`
      : `card ${score} (${tokens.direction ?? "?"}/${tokens.confluence ?? "?"} confluence; ` +
        `MACD ${tokens.macd ?? "?"}; RSI ${tokens.rsi ?? "?"}; ADX ${tokens.adx ?? "?"}; vol ${tokens.vol ?? "?"})`;
  const stopDesc =
    policy.stopRule.kind === "fixed"
      ? `fixed ${(policy.stopRule.pct * 100).toFixed(0)}% from entry`
      : `trailing ${(policy.stopRule.pct * 100).toFixed(0)}% from high-water`;
  return {
    thesis: `Bought on ${why}.`.slice(0, 200),
    invalidation:
      `Exit on signal if card falls below ${policy.sellThreshold} after ` +
      `${policy.minHoldingPeriodRuns} run(s) held, or on a ${stopDesc} stop.`,
  };
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
  options: RunAccountSlotOptions = {},
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
      modelCalls: existing.modelCalls,
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
      modelCalls: 0,
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

  // F7 (docs/paper-trading-v3.md): getLivePrices() ignored traded_at
  // entirely, so a missed refresh could fill at a stale price with nothing
  // recording it. Rethrows on a genuine query failure (paper-db.ts's F12
  // convention) rather than degrading to "no prices" silently.
  let pricesWithAge: Map<string, { price: number; tradedAt: string }>;
  try {
    pricesWithAge = await getLivePricesWithAge(allTickers);
  } catch (err) {
    return persistSkippedRun(
      runId,
      account,
      tradeDate,
      slot,
      dbAccount.policyVersion,
      `price_error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const now = Date.now();
  const isFresh = (tradedAt: string): boolean => now - Date.parse(tradedAt) <= MAX_PRICE_AGE_MINUTES * 60_000;
  // Used for MARK/valuation (every price this run knows about, stale or not —
  // valuing an existing position against its last known price is still more
  // accurate than falling back to avgCost). `prices` keeps the original
  // Map<string, number> shape every downstream call below already expects.
  const prices = new Map<string, number>([...pricesWithAge].map(([t, v]) => [t, v.price]));
  // Used for trading (planRun's `prices` input) — only prices fresh enough to
  // trust for a fill. A stale price must mean "no reference price this slot"
  // to the planner, same as a genuinely missing one, never a real fill price.
  const tradeablePrices = new Map<string, number>(
    [...pricesWithAge].filter(([, v]) => isFresh(v.tradedAt)).map(([t, v]) => [t, v.price]),
  );
  const stalePrices = allTickers.filter((t) => {
    const row = pricesWithAge.get(t);
    return row == null || !isFresh(row.tradedAt);
  });

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
  let recentlyStopped = new Set<string>();
  if (tradingSlot && policy) {
    const horizons = horizonsFor(policy.cardHorizon);
    try {
      const screenRows = await getScreenCandidates(account, horizons, policy.dataQualityGate, barDate);
      candidates = reduceToScorePerTicker(screenRows);
      recentlyStopped = await getRecentlyStoppedTickers(account, stopCooldownStart(tradeDate));
    } catch (err) {
      // F12 (docs/paper-trading-v3.md): a broken screen query must not look
      // like "nothing qualified this run" — that's a real, common outcome
      // (a quiet market) and must stay distinguishable from a query failure.
      return persistSkippedRun(
        runId,
        account,
        tradeDate,
        slot,
        dbAccount.policyVersion,
        `screen_error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const tradeablePricesObj = Object.fromEntries(tradeablePrices);

  // CHAIR reads the other five seats' decisions instead of a fresh score
  // (docs/paper-trading-v3.md §3, §2/§11 Q1's "consensus of the five" design
  // intent) — its own screen above still runs so card_score stays populated
  // on its orders for provenance, but the *plan* comes from votes, not
  // thresholds. Every other trading account keeps planRun with a persona
  // tie-break (lib/shared/paper-persona.ts) instead of the old alphabetical
  // default (F3: alphabetical ties meant every bot bought the same A-D name).
  let plan: { orders: import("@/lib/shared/paper-engine-core").ProposedOrder[]; turnoverUsed: number } = {
    orders: [],
    turnoverUsed: 0,
  };
  if (tradingSlot && policy) {
    if (account === "chair") {
      const siblingSeats = TRADING_ACCOUNTS.filter((a): a is TradingAccount => a !== "chair");
      const siblingRuns = await Promise.all(siblingSeats.map((a) => getRun(a, tradeDate, slot)));
      const totalSeats = siblingRuns.filter((r) => r?.status === "ok").length;
      let siblingOrders: Awaited<ReturnType<typeof getSeatOrdersForSlot>>;
      try {
        siblingOrders = await getSeatOrdersForSlot(tradeDate, slot, siblingSeats);
      } catch (err) {
        // CodeRabbit review, PR #204 (F12 pattern): `totalSeats` above comes
        // from getRun() and doesn't depend on this query, so a broken orders
        // read would otherwise silently plan CHAIR with real totalSeats but
        // zero votes — persisted as a normal `ok` run with no consensus
        // trades and nothing recording why.
        return persistSkippedRun(
          runId,
          account,
          tradeDate,
          slot,
          dbAccount.policyVersion,
          `votes_error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const buyVotes = new Map<string, Set<PaperAccount>>();
      const sellVotes = new Map<string, Set<PaperAccount>>();
      for (const o of siblingOrders) {
        const bucket = o.side === "buy" ? buyVotes : sellVotes;
        if (!bucket.has(o.ticker)) bucket.set(o.ticker, new Set());
        bucket.get(o.ticker)!.add(o.account);
      }
      const tickers = new Set([...buyVotes.keys(), ...sellVotes.keys()]);
      const votes: ConsensusVote[] = [...tickers].map((ticker) => ({
        ticker,
        buyVotes: buyVotes.get(ticker)?.size ?? 0,
        sellVotes: sellVotes.get(ticker)?.size ?? 0,
        totalSeats,
      }));
      plan = planChairConsensus(policy, nav, dbAccount.cash, markedPositions, votes, activeWatchlist, tradeablePricesObj, {
        coreBook: coreBookFor("chair"),
        recentlyStopped,
        candidates,
        tieBreakSeed: tradeDate,
      });
    } else {
      const tieBreak = buildTieBreak(account as TradingAccount, candidates);
      plan = planRun({
        policy,
        nav,
        cash: dbAccount.cash,
        positions: markedPositions,
        candidates,
        activeWatchlist,
        prices: tradeablePricesObj,
        tieBreak,
        tieBreakSeed: tradeDate,
        holdingsFloor: { coreBook: coreBookFor(account as TradingAccount), recentlyStopped },
      });
    }
  }

  const cardScoreByTicker = new Map(candidates.map((c) => [c.ticker, c.score]));

  // ── ARBITRATE (§4.2 step 6, Phase 5) ────────────────────────────────────
  // Applied after planRun's combined PROPOSE+CLIP, before FILL — see
  // lib/shared/paper-engine-core.ts's module doc for why that ordering still
  // honors guardrail #5. QUANT (maxModelCallsPerRun === 0) never enters this
  // block; neither does settle (tradingSlot is false there).
  const arbitrationResults = new Map<string, ArbitrationResult>();
  let modelCallsUsed = 0;
  const positionsByTicker = new Map(markedPositions.map((p) => [p.ticker, p]));
  if (tradingSlot && policy && policy.maxModelCallsPerRun > 0 && options.apiKey && options.globalBudget) {
    const seat = ACCOUNT_SEAT[account as TradingAccount];
    const perRunBudget = Math.min(policy.maxModelCallsPerRun, options.globalBudget.remaining);
    const arbitrationCandidates = selectArbitrationCandidates(
      plan.orders,
      policy,
      positionsByTicker,
      cardScoreByTicker,
      Object.fromEntries(prices),
      perRunBudget,
    );
    for (const candidate of arbitrationCandidates) {
      if (options.globalBudget.remaining <= 0) break;
      try {
        const result = await arbitrateOne(seat, candidate, nav, options.apiKey);
        arbitrationResults.set(result.ticker, result);
      } catch (err) {
        // One failed model call degrades to CONFIRM-none for that ticker,
        // not a failed run — same per-item isolation as the route's
        // per-account try/catch.
        console.warn(
          `[paper-engine] arbitration call failed for ${account}/${candidate.order.ticker}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        // Count the attempt against both budgets whether or not it answered
        // usefully — a call that timed out or errored still spent quota.
        modelCallsUsed++;
        options.globalBudget.remaining--;
      }
    }
  }

  const arbitratedOrders = applyArbitrationResults(plan.orders, arbitrationResults);
  const avgCostByTicker = new Map(markedPositions.map((p) => [p.ticker, p.avgCost]));
  const filled = fillOrders(arbitratedOrders, avgCostByTicker);

  // F12 (docs/paper-trading-v3.md): a veto/downsize shrinks the order list
  // after planRun already computed turnoverUsed, so the stored figure could
  // read e.g. "3% turnover, 0 orders" once a lone flagged buy was vetoed.
  // Recomputed from the orders that actually filled.
  const turnoverUsedActual = nav > 0 ? filled.reduce((sum, o) => sum + o.notional, 0) / nav : 0;

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

  // Ids assigned here (not left to filled.map(() => sql`...randomUUID()...`))
  // so the mirror step below can reference the exact rows just inserted,
  // matching §5.1's "order_id is the Neon uuid" idempotency requirement.
  const tokensByTicker = new Map(candidates.map((c) => [c.ticker, c.tokens]));
  // Only buys get a fresh ticket — a sell deletes the position outright, and
  // a topped-up existing position gets its thesis re-stated against the new
  // fill rather than kept stale from whenever it first opened.
  const ticketByTicker = new Map(
    policy
      ? filled
          .filter((o) => o.side === "buy")
          .map((o) => [o.ticker, ticketText(o.ticker, cardScoreByTicker.get(o.ticker), tokensByTicker.get(o.ticker), policy)])
      : [],
  );

  const filledWithIds = filled.map((o) => ({ ...o, id: randomUUID() }));
  const arbitrationDetail = [...arbitrationResults.values()].map((r) => ({
    ticker: r.ticker,
    action: r.action,
    downsizePct: r.downsizePct ?? null,
    model: r.model,
    why: r.why ?? null,
  }));
  const runDetail: Record<string, unknown> = { turnoverUsed: turnoverUsedActual, arbitration: arbitrationDetail };
  // F2 (docs/paper-trading-v3.md): the code's own PAPER_POLICY_VERSION is
  // what actually ran, not whatever paper_accounts.policy_version happens to
  // say — the 2026-09-29 "first v2 trade" ran v1 thresholds under a v2 label
  // because the stamp was read from the account row, not the deployed code.
  if (dbAccount.policyVersion !== PAPER_POLICY_VERSION) {
    runDetail.account_policy_version = dbAccount.policyVersion;
    runDetail.policy_version_mismatch = true;
  }
  if (stalePrices.length > 0) runDetail.stale_prices = stalePrices;
  if (options.late) runDetail.late = true;

  const queries = [
    sql`
      INSERT INTO paper_runs
        (id, account, trade_date, slot, status, skip_reason, candidates_n, orders_n,
         model_calls, policy_version, detail, finished_at)
      VALUES (
        ${runId}, ${account}, ${tradeDate}, ${slot}, 'ok', null, ${candidates.length},
        ${filled.length}, ${modelCallsUsed}, ${PAPER_POLICY_VERSION},
        ${JSON.stringify(runDetail)}, now()
      )
      ON CONFLICT (account, trade_date, slot) DO NOTHING
    `,
    ...filledWithIds.map((o) => {
      const decision = arbitrationResults.get(o.ticker);
      return sql`
        INSERT INTO paper_orders
          (id, run_id, account, ticker, side, quantity, ref_price, fill_price,
           slippage_bps, notional, realized_pnl, reason, decided_by, model, card_score)
        VALUES (
          ${o.id}, ${runId}, ${account}, ${o.ticker}, ${o.side}, ${o.quantity},
          ${o.refPrice}, ${o.fillPrice}, ${o.slippageBps}, ${o.notional}, ${o.realizedPnl},
          ${o.reason}, ${decision ? "model" : "rule"}, ${decision?.model ?? null},
          ${cardScoreByTicker.get(o.ticker) ?? null}
        )
      `;
    }),
    ...[...finalPositions.values()].map((p) => {
      const ticket = ticketByTicker.get(p.ticker) ?? null;
      return sql`
        INSERT INTO paper_positions
          (account, ticker, quantity, avg_cost, opened_at, last_trade_at, runs_held, high_water, thesis, invalidation)
        VALUES (
          ${account}, ${p.ticker}, ${p.quantity}, ${p.avgCost}, now(), now(), ${p.runsHeld}, ${p.highWater},
          ${ticket?.thesis ?? null}, ${ticket?.invalidation ?? null}
        )
        ON CONFLICT (account, ticker) DO UPDATE SET
          quantity      = EXCLUDED.quantity,
          avg_cost      = EXCLUDED.avg_cost,
          last_trade_at = now(),
          runs_held     = EXCLUDED.runs_held,
          high_water    = EXCLUDED.high_water,
          -- A run that only marks this position (no new buy) sends a null
          -- ticket; COALESCE keeps the existing thesis instead of blanking
          -- it every time the position is merely revalued.
          thesis        = COALESCE(EXCLUDED.thesis, paper_positions.thesis),
          invalidation  = COALESCE(EXCLUDED.invalidation, paper_positions.invalidation)
      `;
    }),
    ...[...deletedTickers].map(
      (ticker) => sql`DELETE FROM paper_positions WHERE account = ${account} AND ticker = ${ticker}`,
    ),
    sql`UPDATE paper_accounts SET cash = ${finalCash}, updated_at = now() WHERE account = ${account}`,
    sql`
      INSERT INTO paper_nav
        (account, trade_date, slot, cash, positions_mv, nav, day_return, total_return, positions_n, turnover)
      VALUES (
        ${account}, ${tradeDate}, ${slot}, ${finalCash}, ${finalPositionsMv}, ${finalNav},
        ${dayReturn}, ${totalReturn}, ${finalPositions.size}, ${turnoverUsedActual}
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
        modelCalls: winner.modelCalls,
        alreadyRan: true,
      };
    }
    throw err;
  }

  // ── Mirror + reconcile (Phase 6) ────────────────────────────────────────
  // Only reached after the Neon transaction above has committed — mirroring
  // a run that lost the idempotency race (the FK-abort path above) would
  // mirror state this process never actually wrote. Both calls are
  // best-effort: neither can fail this function, only annotate its detail.
  const mirrorErrors: string[] = [];

  if (watchlist.length > 0) {
    const watchlistMirror = await mirrorWatchlistIfVersionChanged({
      account,
      watchlistVersion: watchlist[0].watchlistVersion,
      entries: watchlist,
    });
    if (!watchlistMirror.ok && watchlistMirror.error !== "not_configured") {
      mirrorErrors.push(`watchlist: ${watchlistMirror.error}`);
    }
  }

  const mirrorPositions = [...finalPositions.values()].map((p) => ({
    ticker: p.ticker,
    quantity: p.quantity,
    avgCost: p.avgCost,
    mv: p.quantity * (prices.get(p.ticker) ?? p.avgCost),
    weight: finalNav > 0 ? (p.quantity * (prices.get(p.ticker) ?? p.avgCost)) / finalNav : 0,
    runsHeld: p.runsHeld,
  }));
  const newOrders: OrderRow[] = filledWithIds.map((o) => ({
    id: o.id,
    runId,
    account,
    ticker: o.ticker,
    side: o.side,
    quantity: o.quantity,
    refPrice: o.refPrice,
    fillPrice: o.fillPrice,
    slippageBps: o.slippageBps,
    notional: o.notional,
    realizedPnl: o.realizedPnl,
    reason: o.reason,
    decidedBy: arbitrationResults.has(o.ticker) ? "model" : "rule",
    model: arbitrationResults.get(o.ticker)?.model ?? null,
    cardScore: cardScoreByTicker.get(o.ticker) ?? null,
    createdAt: new Date().toISOString(),
  }));

  const accountMirror = await mirrorPaperAccount({
    account,
    seat: dbAccount.seat,
    label: dbAccount.label,
    policyVersion: dbAccount.policyVersion,
    cash: finalCash,
    nav: finalNav,
    totalReturn,
    tradeDate,
    slot,
    runStatus: "ok",
    skipReason: null,
    ordersN: filled.length,
    modelCalls: modelCallsUsed,
    positions: mirrorPositions,
    newOrders,
    navPoint: {
      account,
      tradeDate,
      slot,
      cash: finalCash,
      positionsMv: finalPositionsMv,
      nav: finalNav,
      dayReturn,
      totalReturn,
      positionsN: finalPositions.size,
      turnover: turnoverUsedActual,
    },
  });
  if (!accountMirror.ok && accountMirror.error !== "not_configured") {
    mirrorErrors.push(`account: ${accountMirror.error}`);
  }

  const detailPatch: Record<string, unknown> = {};
  if (mirrorErrors.length > 0) detailPatch.mirror_error = mirrorErrors.join("; ");

  // Reconciliation only runs at settle (§5.1) — comparing mid-day Neon state
  // against a mirror the same run just wrote would trivially agree and tell
  // us nothing about drift accumulated over the day's earlier slots.
  if (slot === "settle") {
    const reconcile = await reconcileAccount({
      account,
      neonCash: finalCash,
      neonNav: finalNav,
      neonPositionsN: finalPositions.size,
      neonOrdersN: await countOrders(account),
    });
    detailPatch.reconcile = reconcile;

    // Metrics (§7, Phase 8) — best-effort, same as mirror/reconcile: a
    // scoring failure must never fail the run that already committed its
    // Neon transaction. Read fresh from the DB (not the in-memory state
    // above) since the settle NAV row this run just wrote is part of the
    // series computeMetricsForAccount reads.
    try {
      detailPatch.metrics = await computeMetricsForAccount(account);
    } catch (err) {
      console.warn(`[paper-engine] metrics computation failed for ${account}: ${err}`);
    }
  }

  if (Object.keys(detailPatch).length > 0) {
    await updateRunDetail(runId, detailPatch).catch((err) => {
      console.warn(`[paper-engine] failed to record mirror/reconcile detail for ${account}: ${err}`);
    });
  }

  return {
    account,
    tradeDate,
    slot,
    status: "ok",
    skipReason: null,
    candidatesN: candidates.length,
    ordersN: filled.length,
    modelCalls: modelCallsUsed,
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
    modelCalls: 0,
    alreadyRan: false,
  };
}

/** Today's calendar date in US/Eastern, `YYYY-MM-DD` — the `trade_date` every
 *  slot for "today" is keyed on (§4.1's cadence is defined in ET). */
export function todayEasternDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}
