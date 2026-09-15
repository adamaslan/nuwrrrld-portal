/**
 * paper-reconcile — the settle-only drift check between Neon and the
 * Firestore mirror (docs/council-paper-portfolios.md §5.1 "Reconciliation",
 * Phase 6 of docs/paper-portfolios-remaining-todo.md).
 *
 * Compares NAV, cash, position count, and order count per account. A
 * non-zero order-count delta is the loud one — per §5.1 it means a mirror
 * write was lost, and the fix is a re-mirror, never a recalculation (this
 * module only ever reads; it has no write path back into either store).
 * Never throws — a comparison that can't complete (Firestore unreachable or
 * not configured) reports `checked: false`, not a run failure, matching every
 * other Firestore touchpoint in this phase (guardrail #7).
 */
import { getPaperFirestore } from "@/lib/firestore-admin";
import type { PaperAccount } from "@/lib/shared/paper-policy";

export interface ReconcileInput {
  account: PaperAccount;
  neonCash: number;
  neonNav: number;
  neonPositionsN: number;
  /** Total paper_orders rows for this account, all time — matched against
   *  the Firestore orders subcollection's doc count (append-only, so a plain
   *  count is the right comparison on both sides). */
  neonOrdersN: number;
}

export interface ReconcileResult {
  checked: boolean;
  ok: boolean;
  cashDelta: number | null;
  navDelta: number | null;
  positionsNDelta: number | null;
  ordersNDelta: number | null;
  error?: string;
}

/** Absolute NAV/cash disagreement below this (dollars) is float/rounding
 *  noise across two independently-updated stores, not real drift. */
const MONEY_DELTA_TOLERANCE = 0.01;

export async function reconcileAccount(input: ReconcileInput): Promise<ReconcileResult> {
  const db = getPaperFirestore();
  if (!db) {
    return {
      checked: false,
      ok: false,
      cashDelta: null,
      navDelta: null,
      positionsNDelta: null,
      ordersNDelta: null,
      error: "not_configured",
    };
  }

  try {
    const [accountSnap, positionsCount, ordersCount] = await Promise.all([
      db.doc(`paper/${input.account}`).get(),
      db.collection(`paper/${input.account}/positions`).count().get(),
      db.collection(`paper/${input.account}/orders`).count().get(),
    ]);

    const fsCash = accountSnap.exists ? Number(accountSnap.get("cash")) : NaN;
    const fsNav = accountSnap.exists ? Number(accountSnap.get("nav")) : NaN;
    const fsPositionsN = positionsCount.data().count;
    const fsOrdersN = ordersCount.data().count;

    const cashDelta = Number.isFinite(fsCash) ? input.neonCash - fsCash : null;
    const navDelta = Number.isFinite(fsNav) ? input.neonNav - fsNav : null;
    const positionsNDelta = input.neonPositionsN - fsPositionsN;
    const ordersNDelta = input.neonOrdersN - fsOrdersN;

    const ok =
      (cashDelta === null || Math.abs(cashDelta) < MONEY_DELTA_TOLERANCE) &&
      (navDelta === null || Math.abs(navDelta) < MONEY_DELTA_TOLERANCE) &&
      positionsNDelta === 0 &&
      ordersNDelta === 0;

    return { checked: true, ok, cashDelta, navDelta, positionsNDelta, ordersNDelta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      checked: false,
      ok: false,
      cashDelta: null,
      navDelta: null,
      positionsNDelta: null,
      ordersNDelta: null,
      error: message,
    };
  }
}
