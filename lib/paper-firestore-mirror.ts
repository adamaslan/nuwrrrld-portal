/**
 * paper-firestore-mirror — writes the paper-portfolio read mirror to
 * Firestore (docs/council-paper-portfolios.md §5.1, Phase 6 of
 * docs/paper-portfolios-remaining-todo.md).
 *
 * Neon is the source of truth (§5.1's table) — this mirror is reconstructable
 * from it at any time. Every write here is best-effort: `mirrorPaperAccount`
 * never throws, and `lib/paper-engine.ts` records a failure into the run's
 * own `paper_runs.detail.mirror_error` without failing the run (guardrail
 * #7). Called once per (account, slot) *after* the run's Neon transaction has
 * already committed — mirroring committed-but-possibly-stale state is always
 * safe; mirroring uncommitted state would not be.
 *
 * Known simplification: only the *active* watchlist mirrors (via
 * `mirrorWatchlistIfVersionChanged`), not deactivated rows. §5.1's Firestore
 * layout lists an `active`/`drop_reason` field per watchlist doc, which
 * implies dropped tickers stay visible with `active: false`; this phase
 * mirrors only what `paper_watchlists`'s active rows show today. Reading and
 * mirroring the full (including inactive) history is deferred, not silently
 * dropped — flagging it here per this repo's convention for stated, not
 * invented, simplifications.
 */
import { getPaperFirestore } from "@/lib/firestore-admin";
import { sectorFor } from "@/lib/shared/paper-sectors";
import type { PaperAccount } from "@/lib/shared/paper-policy";
import type { NavPoint, OrderRow, RunStatus, Slot, WatchlistEntry } from "@/lib/paper-db";

export interface MirrorResult {
  ok: boolean;
  error?: string;
}

export interface MirrorPosition {
  ticker: string;
  quantity: number;
  avgCost: number;
  mv: number;
  weight: number;
  runsHeld: number;
}

export interface MirrorRunInput {
  account: PaperAccount;
  seat: string | null;
  label: string;
  policyVersion: string;
  cash: number;
  nav: number;
  totalReturn: number | null;
  tradeDate: string;
  slot: Slot;
  runStatus: RunStatus;
  skipReason: string | null;
  ordersN: number;
  modelCalls: number;
  positions: MirrorPosition[];
  newOrders: OrderRow[];
  navPoint: NavPoint;
}

/**
 * Mirrors the account summary doc, the full current positions subcollection
 * (stale docs for closed-out tickers are deleted, not left behind — position
 * counts per account are small, so the extra `listDocuments()` read is
 * cheap), this run's new orders (append-only, doc id = the Neon order uuid,
 * so a replayed mirror is idempotent per §5.1), the day's NAV doc (one field
 * per slot), and the run-status doc.
 */
export async function mirrorPaperAccount(input: MirrorRunInput): Promise<MirrorResult> {
  const db = getPaperFirestore();
  if (!db) return { ok: false, error: "not_configured" };

  try {
    const batch = db.batch();
    const accountRef = db.doc(`paper/${input.account}`);
    batch.set(
      accountRef,
      {
        label: input.label,
        seat: input.seat,
        cash: input.cash,
        nav: input.nav,
        total_return: input.totalReturn,
        positions_n: input.positions.length,
        policy_version: input.policyVersion,
        last_run: { trade_date: input.tradeDate, slot: input.slot, status: input.runStatus },
      },
      { merge: true },
    );

    const existingPositionDocs = await db.collection(`paper/${input.account}/positions`).listDocuments();
    const currentTickers = new Set(input.positions.map((p) => p.ticker));
    for (const doc of existingPositionDocs) {
      if (!currentTickers.has(doc.id)) batch.delete(doc);
    }
    for (const p of input.positions) {
      batch.set(db.doc(`paper/${input.account}/positions/${p.ticker}`), {
        quantity: p.quantity,
        avg_cost: p.avgCost,
        mv: p.mv,
        weight: p.weight,
        runs_held: p.runsHeld,
      });
    }

    for (const o of input.newOrders) {
      batch.set(db.doc(`paper/${input.account}/orders/${o.id}`), {
        side: o.side,
        quantity: o.quantity,
        ref_price: o.refPrice,
        fill_price: o.fillPrice,
        slippage_bps: o.slippageBps,
        notional: o.notional,
        realized_pnl: o.realizedPnl,
        reason: o.reason,
        decided_by: o.decidedBy,
        model: o.model,
        card_score: o.cardScore,
        created_at: o.createdAt,
      });
    }

    // One doc per trade_date, one field per slot — the whole day's series
    // reads in a single get() (§5.1: "the day's four slots + close NAV").
    batch.set(
      db.doc(`paper/${input.account}/nav/${input.tradeDate}`),
      {
        [input.slot]: {
          cash: input.navPoint.cash,
          positions_mv: input.navPoint.positionsMv,
          nav: input.navPoint.nav,
          day_return: input.navPoint.dayReturn,
          total_return: input.navPoint.totalReturn,
          positions_n: input.navPoint.positionsN,
          turnover: input.navPoint.turnover,
        },
      },
      { merge: true },
    );

    batch.set(db.doc(`paper/${input.account}/runs/${input.tradeDate}_${input.slot}`), {
      status: input.runStatus,
      skip_reason: input.skipReason,
      orders_n: input.ordersN,
      model_calls: input.modelCalls,
    });

    await batch.commit();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[paper-firestore-mirror] mirror failed for ${input.account}/${input.tradeDate}/${input.slot}: ${message}`,
    );
    return { ok: false, error: message };
  }
}

export interface MirrorWatchlistInput {
  account: PaperAccount;
  watchlistVersion: number;
  entries: WatchlistEntry[];
}

/**
 * Mirrors the full active watchlist only when the account doc's own recorded
 * `watchlist_version` disagrees with the current one — seed time and any
 * future version bump, never every run (§5.1: "watchlists mirror on seed and
 * on version bump, not every run" — re-writing ~60 docs per account four
 * times a day to say nothing would be the largest write cost in the design).
 */
export async function mirrorWatchlistIfVersionChanged(input: MirrorWatchlistInput): Promise<MirrorResult> {
  const db = getPaperFirestore();
  if (!db) return { ok: false, error: "not_configured" };

  try {
    const accountRef = db.doc(`paper/${input.account}`);
    const snap = await accountRef.get();
    const mirroredVersion = snap.exists ? (snap.get("watchlist_version") as number | undefined) : undefined;
    if (mirroredVersion === input.watchlistVersion) {
      return { ok: true };
    }

    const batch = db.batch();
    for (const w of input.entries) {
      batch.set(db.doc(`paper/${input.account}/watchlist/${w.ticker}`), {
        in_seed_book: w.inSeedBook,
        active: w.active,
        sector: sectorFor(w.ticker),
        watchlist_version: w.watchlistVersion,
        drop_reason: w.dropReason,
      });
    }
    batch.set(accountRef, { watchlist_version: input.watchlistVersion }, { merge: true });
    await batch.commit();
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[paper-firestore-mirror] watchlist mirror failed for ${input.account}: ${message}`);
    return { ok: false, error: message };
  }
}
