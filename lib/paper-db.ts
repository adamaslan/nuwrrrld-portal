/**
 * paper-db — Neon persistence for the council paper-portfolio simulation
 * (docs/council-paper-portfolios.md §5). Six tables:
 *   paper_accounts    — one row per account, ever (8 total)
 *   paper_runs        — one row per run attempt, idempotent on (account, trade_date, slot)
 *   paper_watchlists  — the fixed candidate pool per account, versioned
 *   paper_positions   — current book, one row per (account, ticker)
 *   paper_orders      — append-only transaction log
 *   paper_nav         — mark-to-market series, one row per (account, date, slot)
 *
 * Narrow, no business logic — same shape as lib/followed-tickers-db.ts. Reads
 * degrade to null/[] on failure so a rendering path can still show something;
 * writes to the hard system-of-record tables (orders, positions, nav, runs)
 * surface errors, since a dropped fill silently breaks the leaderboard's
 * comparability (§4.4).
 */
import { randomUUID } from "node:crypto";
import sql from "@/lib/db";
import type { PaperAccount } from "@/lib/shared/paper-policy";

export type Slot = "preopen" | "midday" | "preclose" | "settle";
export type RunStatus = "ok" | "skipped" | "degraded" | "failed";
export type OrderSide = "buy" | "sell";
export type DecidedBy = "rule" | "model";

export interface Account {
  account: PaperAccount;
  seat: string | null;
  label: string;
  policyVersion: string;
  startingCash: number;
  cash: number;
  seededOn: string;
  active: boolean;
  updatedAt: string;
}

function rowToAccount(r: Record<string, unknown>): Account {
  return {
    account: r.account as PaperAccount,
    seat: (r.seat as string) ?? null,
    label: r.label as string,
    policyVersion: r.policy_version as string,
    startingCash: Number(r.starting_cash),
    cash: Number(r.cash),
    seededOn: new Date(r.seeded_on as string).toISOString().slice(0, 10),
    active: Boolean(r.active),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export async function getAccount(account: PaperAccount): Promise<Account | null> {
  try {
    const rows = await sql`SELECT * FROM paper_accounts WHERE account = ${account}`;
    return rows[0] ? rowToAccount(rows[0]) : null;
  } catch {
    return null;
  }
}

export async function listAccounts(): Promise<Account[]> {
  try {
    const rows = await sql`SELECT * FROM paper_accounts ORDER BY account`;
    return rows.map(rowToAccount);
  } catch {
    return [];
  }
}

export async function updateCash(account: PaperAccount, cash: number): Promise<void> {
  await sql`
    UPDATE paper_accounts SET cash = ${cash}, updated_at = now() WHERE account = ${account}
  `;
}

// ── Watchlists ──────────────────────────────────────────────────────────────

export interface WatchlistEntry {
  account: PaperAccount;
  ticker: string;
  watchlistVersion: number;
  inSeedBook: boolean;
  active: boolean;
  deactivatedAt: string | null;
  dropReason: string | null;
  addedAt: string;
}

function rowToWatchlistEntry(r: Record<string, unknown>): WatchlistEntry {
  return {
    account: r.account as PaperAccount,
    ticker: r.ticker as string,
    watchlistVersion: Number(r.watchlist_version),
    inSeedBook: Boolean(r.in_seed_book),
    active: Boolean(r.active),
    deactivatedAt: r.deactivated_at ? new Date(r.deactivated_at as string).toISOString() : null,
    dropReason: (r.drop_reason as string) ?? null,
    addedAt: new Date(r.added_at as string).toISOString(),
  };
}

/** The account's live candidate pool — the outer bound step 3 (SCREEN) joins
 *  ticker_cards against (§4.2). */
export async function listActiveWatchlist(account: PaperAccount): Promise<WatchlistEntry[]> {
  try {
    const rows = await sql`
      SELECT * FROM paper_watchlists WHERE account = ${account} AND active
      ORDER BY ticker
    `;
    return rows.map(rowToWatchlistEntry);
  } catch {
    return [];
  }
}

/** True if `ticker` is currently buyable for `account` — the app-side mirror
 *  of the paper_orders_watchlist_guard trigger, so a rejected buy can be
 *  reported as `cap_clip`/similar before it ever reaches the DB. */
export async function isOnActiveWatchlist(
  account: PaperAccount,
  ticker: string,
): Promise<boolean> {
  try {
    const rows = await sql`
      SELECT 1 FROM paper_watchlists
      WHERE account = ${account} AND ticker = ${ticker} AND active
      LIMIT 1
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Deactivate a watchlist row on delisting/universe-drop/policy, mirroring
 *  followed_ticker_picks' markPickDropped idiom exactly. Idempotent. */
export async function deactivateWatchlistEntry(
  account: PaperAccount,
  ticker: string,
  watchlistVersion: number,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE paper_watchlists
    SET active = false, deactivated_at = now(), drop_reason = ${reason}
    WHERE account = ${account} AND ticker = ${ticker}
      AND watchlist_version = ${watchlistVersion} AND active
  `;
}

// ── Positions ───────────────────────────────────────────────────────────────

export interface Position {
  account: PaperAccount;
  ticker: string;
  quantity: number;
  avgCost: number;
  openedAt: string;
  lastTradeAt: string;
  runsHeld: number;
  highWater: number;
  thesis: string | null;
  invalidation: string | null;
}

function rowToPosition(r: Record<string, unknown>): Position {
  return {
    account: r.account as PaperAccount,
    ticker: r.ticker as string,
    quantity: Number(r.quantity),
    avgCost: Number(r.avg_cost),
    openedAt: new Date(r.opened_at as string).toISOString(),
    lastTradeAt: new Date(r.last_trade_at as string).toISOString(),
    runsHeld: Number(r.runs_held),
    highWater: Number(r.high_water),
    thesis: (r.thesis as string) ?? null,
    invalidation: (r.invalidation as string) ?? null,
  };
}

export async function getPositions(account: PaperAccount): Promise<Position[]> {
  try {
    const rows = await sql`
      SELECT * FROM paper_positions WHERE account = ${account} ORDER BY ticker
    `;
    return rows.map(rowToPosition);
  } catch {
    return [];
  }
}

/** Full-exit delete — positions have no zero-quantity state (CHECK quantity > 0). */
export async function deletePosition(account: PaperAccount, ticker: string): Promise<void> {
  await sql`DELETE FROM paper_positions WHERE account = ${account} AND ticker = ${ticker}`;
}

export async function upsertPosition(p: Position): Promise<void> {
  await sql`
    INSERT INTO paper_positions
      (account, ticker, quantity, avg_cost, opened_at, last_trade_at, runs_held, high_water, thesis, invalidation)
    VALUES (
      ${p.account}, ${p.ticker}, ${p.quantity}, ${p.avgCost}, ${p.openedAt}, ${p.lastTradeAt},
      ${p.runsHeld}, ${p.highWater}, ${p.thesis}, ${p.invalidation}
    )
    ON CONFLICT (account, ticker) DO UPDATE SET
      quantity      = EXCLUDED.quantity,
      avg_cost      = EXCLUDED.avg_cost,
      last_trade_at = EXCLUDED.last_trade_at,
      runs_held     = EXCLUDED.runs_held,
      high_water    = EXCLUDED.high_water,
      thesis        = EXCLUDED.thesis,
      invalidation  = EXCLUDED.invalidation
  `;
}

// ── Orders (append-only) ────────────────────────────────────────────────────

export interface NewOrder {
  runId: string;
  account: PaperAccount;
  ticker: string;
  side: OrderSide;
  quantity: number;
  refPrice: number;
  fillPrice: number;
  slippageBps: number;
  notional: number;
  realizedPnl: number | null;
  reason: string;
  decidedBy: DecidedBy;
  model: string | null;
  cardScore: number | null;
}

/** Insert one fill. Buys are rejected at the DB level by
 *  paper_orders_watchlist_guard_trg if the ticker isn't on an active
 *  watchlist — callers should still pre-check via isOnActiveWatchlist() so a
 *  rejection can be reported as a CLIP reason rather than surfacing as a raw
 *  DB error. */
export async function insertOrder(o: NewOrder): Promise<string> {
  // id is supplied here, not left to the Postgres DEFAULT, so the row is
  // valid on the SQLite mirror too — its generated schema drops the
  // gen_random_uuid() default (same convention as lib/pipeline-run-log-db.ts).
  const id = randomUUID();
  await sql`
    INSERT INTO paper_orders
      (id, run_id, account, ticker, side, quantity, ref_price, fill_price, slippage_bps,
       notional, realized_pnl, reason, decided_by, model, card_score)
    VALUES (
      ${id}, ${o.runId}, ${o.account}, ${o.ticker}, ${o.side}, ${o.quantity}, ${o.refPrice},
      ${o.fillPrice}, ${o.slippageBps}, ${o.notional}, ${o.realizedPnl}, ${o.reason},
      ${o.decidedBy}, ${o.model}, ${o.cardScore}
    )
  `;
  return id;
}

export interface OrderRow extends NewOrder {
  id: string;
  createdAt: string;
}

/** Newest-first, paginated — the same rows mirrored to Firestore (§5.1). */
export async function listOrders(
  account: PaperAccount,
  limit = 20,
  offset = 0,
): Promise<OrderRow[]> {
  try {
    const rows = await sql`
      SELECT * FROM paper_orders WHERE account = ${account}
      ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map((r) => ({
      id: r.id as string,
      runId: r.run_id as string,
      account: r.account as PaperAccount,
      ticker: r.ticker as string,
      side: r.side as OrderSide,
      quantity: Number(r.quantity),
      refPrice: Number(r.ref_price),
      fillPrice: Number(r.fill_price),
      slippageBps: Number(r.slippage_bps),
      notional: Number(r.notional),
      realizedPnl: r.realized_pnl == null ? null : Number(r.realized_pnl),
      reason: r.reason as string,
      decidedBy: r.decided_by as DecidedBy,
      model: (r.model as string) ?? null,
      cardScore: r.card_score == null ? null : Number(r.card_score),
      createdAt: new Date(r.created_at as string).toISOString(),
    }));
  } catch {
    return [];
  }
}

// ── NAV ─────────────────────────────────────────────────────────────────────

export interface NavPoint {
  account: PaperAccount;
  tradeDate: string;
  slot: Slot;
  cash: number;
  positionsMv: number;
  nav: number;
  dayReturn: number | null;
  totalReturn: number | null;
  positionsN: number;
  turnover: number;
}

export async function insertNav(n: NavPoint): Promise<void> {
  await sql`
    INSERT INTO paper_nav
      (account, trade_date, slot, cash, positions_mv, nav, day_return, total_return, positions_n, turnover)
    VALUES (
      ${n.account}, ${n.tradeDate}, ${n.slot}, ${n.cash}, ${n.positionsMv}, ${n.nav},
      ${n.dayReturn}, ${n.totalReturn}, ${n.positionsN}, ${n.turnover}
    )
    ON CONFLICT (account, trade_date, slot) DO UPDATE SET
      cash         = EXCLUDED.cash,
      positions_mv = EXCLUDED.positions_mv,
      nav          = EXCLUDED.nav,
      day_return   = EXCLUDED.day_return,
      total_return = EXCLUDED.total_return,
      positions_n  = EXCLUDED.positions_n,
      turnover     = EXCLUDED.turnover
  `;
}

export async function getNavSeries(account: PaperAccount, limit = 200): Promise<NavPoint[]> {
  try {
    const rows = await sql`
      SELECT * FROM paper_nav WHERE account = ${account}
      ORDER BY trade_date DESC, slot DESC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      account: r.account as PaperAccount,
      tradeDate: new Date(r.trade_date as string).toISOString().slice(0, 10),
      slot: r.slot as Slot,
      cash: Number(r.cash),
      positionsMv: Number(r.positions_mv),
      nav: Number(r.nav),
      dayReturn: r.day_return == null ? null : Number(r.day_return),
      totalReturn: r.total_return == null ? null : Number(r.total_return),
      positionsN: Number(r.positions_n),
      turnover: Number(r.turnover),
    }));
  } catch {
    return [];
  }
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export interface RunRow {
  id: string;
  account: PaperAccount;
  tradeDate: string;
  slot: Slot;
  status: RunStatus;
  skipReason: string | null;
  candidatesN: number | null;
  ordersN: number | null;
  modelCalls: number;
  policyVersion: string;
  detail: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

function rowToRun(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as string,
    account: r.account as PaperAccount,
    tradeDate: new Date(r.trade_date as string).toISOString().slice(0, 10),
    slot: r.slot as Slot,
    status: r.status as RunStatus,
    skipReason: (r.skip_reason as string) ?? null,
    candidatesN: r.candidates_n == null ? null : Number(r.candidates_n),
    ordersN: r.orders_n == null ? null : Number(r.orders_n),
    modelCalls: Number(r.model_calls),
    policyVersion: r.policy_version as string,
    detail: (r.detail as Record<string, unknown>) ?? {},
    startedAt: new Date(r.started_at as string).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
  };
}

/** The idempotency read — §4.4. A caller finding a row here for
 *  (account, trade_date, slot) must treat the run as already done and
 *  return this row rather than filling again. */
export async function getRun(
  account: PaperAccount,
  tradeDate: string,
  slot: Slot,
): Promise<RunRow | null> {
  try {
    const rows = await sql`
      SELECT * FROM paper_runs
      WHERE account = ${account} AND trade_date = ${tradeDate} AND slot = ${slot}
    `;
    return rows[0] ? rowToRun(rows[0]) : null;
  } catch {
    return null;
  }
}

export interface NewRun {
  account: PaperAccount;
  tradeDate: string;
  slot: Slot;
  status: RunStatus;
  skipReason?: string | null;
  candidatesN?: number | null;
  ordersN?: number | null;
  modelCalls?: number;
  policyVersion: string;
  detail?: Record<string, unknown>;
  finishedAt?: string | null;
}

/** Insert the run row. `ON CONFLICT DO NOTHING` on the (account, trade_date,
 *  slot) unique key means a race against another caller for the same slot
 *  never produces two rows — the loser's insert is simply absorbed, and it
 *  should re-read via getRun() to pick up the winner's row. */
export async function insertRun(r: NewRun): Promise<string | null> {
  // Same id-supplied-by-the-app reasoning as insertOrder above. RETURNING id
  // would come back empty on the ON CONFLICT DO NOTHING no-op path anyway, so
  // returning the id we generated (only when the insert actually happened)
  // needs the row-count check, not a RETURNING clause.
  const id = randomUUID();
  const rows = await sql`
    INSERT INTO paper_runs
      (id, account, trade_date, slot, status, skip_reason, candidates_n, orders_n,
       model_calls, policy_version, detail, finished_at)
    VALUES (
      ${id}, ${r.account}, ${r.tradeDate}, ${r.slot}, ${r.status}, ${r.skipReason ?? null},
      ${r.candidatesN ?? null}, ${r.ordersN ?? null}, ${r.modelCalls ?? 0},
      ${r.policyVersion}, ${JSON.stringify(r.detail ?? {})}, ${r.finishedAt ?? null}
    )
    ON CONFLICT (account, trade_date, slot) DO NOTHING
    RETURNING id
  `;
  return rows[0]?.id ? (rows[0].id as string) : null;
}

/**
 * Merge `patch` into the run's detail blob. Deliberately a read-then-write in
 * application code rather than Postgres's `jsonb ||` operator: that operator
 * has no SQLite equivalent, and this module is otherwise plain
 * `` sql`...` `` with no unnest()/ANY()/string_agg() idioms — worth keeping
 * fully covered by the db-parity suite rather than joining the excluded list
 * in __tests__/db-parity/README.md over one merge call.
 */
export async function updateRunDetail(
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const rows = await sql`SELECT detail FROM paper_runs WHERE id = ${runId}`;
  const current = (rows[0]?.detail as Record<string, unknown>) ?? {};
  const merged = { ...current, ...patch };
  await sql`UPDATE paper_runs SET detail = ${JSON.stringify(merged)} WHERE id = ${runId}`;
}
