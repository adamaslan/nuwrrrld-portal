/**
 * paper-status-db — the read model behind the paper-trading section of
 * /dashboard/nulogdash/pipelines: one row per simulated account with its
 * latest run per slot, latest NAV, and open-position count.
 *
 * Read-only and deliberately separate from paper-db.ts, which is shaped for
 * the engine's writes and per-account pages. Unlike paper-db's reads this
 * throws on failure, matching pipeline-run-log-db: a console that shows
 * "never run" when the query broke is worse than one that errors.
 */
import sql from "@/lib/db";
import type { PaperAccount } from "@/lib/shared/paper-policy";
import { PAPER_ACCOUNTS } from "@/lib/shared/paper-policy";
import type { RunStatus, Slot } from "@/lib/paper-db";

export const PAPER_SLOTS: readonly Slot[] = ["preopen", "midday", "preclose", "settle"];

export interface SlotRunStatus {
  slot: Slot;
  tradeDate: string;
  status: RunStatus;
  skipReason: string | null;
  ordersN: number | null;
  modelCalls: number;
  startedAt: string;
}

export interface PaperAccountStatus {
  account: PaperAccount;
  label: string;
  seat: string | null;
  active: boolean;
  cash: number;
  startingCash: number;
  /** Latest mark-to-market point, or null if the account has never marked. */
  nav: number | null;
  totalReturn: number | null;
  navDate: string | null;
  openPositions: number;
  /** One entry per slot in PAPER_SLOTS order; `null` = that slot never ran. */
  slots: Array<SlotRunStatus | null>;
}

export interface PaperAccountRows {
  accounts: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  nav: Array<Record<string, unknown>>;
  positions: Array<Record<string, unknown>>;
}

function toIsoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toIsoTimestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toNullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

/**
 * Fold the four raw result sets into one status per account. Pure, so the
 * console's logic is testable without Neon. Accounts with no row in
 * paper_accounts still appear (label falls back to the key) so a missing seed
 * is visible rather than silently dropped.
 */
export function buildPaperAccountStatuses(rows: PaperAccountRows): PaperAccountStatus[] {
  const byAccount = <T extends Record<string, unknown>>(list: T[]) => {
    const map = new Map<string, T>();
    for (const row of list) map.set(String(row.account), row);
    return map;
  };
  const accountRows = byAccount(rows.accounts);
  const navRows = byAccount(rows.nav);
  const positionCounts = new Map(
    rows.positions.map((r) => [String(r.account), Number(r.open_positions)] as const),
  );

  return PAPER_ACCOUNTS.map((account) => {
    const meta = accountRows.get(account);
    const nav = navRows.get(account);
    const slots = PAPER_SLOTS.map((slot) => {
      const run = rows.runs.find((r) => r.account === account && r.slot === slot);
      if (!run) return null;
      return {
        slot,
        tradeDate: toIsoDate(run.trade_date),
        status: run.status as RunStatus,
        skipReason: (run.skip_reason as string | null) ?? null,
        ordersN: toNullableNumber(run.orders_n),
        modelCalls: Number(run.model_calls ?? 0),
        startedAt: toIsoTimestamp(run.started_at),
      };
    });
    return {
      account,
      label: meta ? String(meta.label) : account,
      seat: meta ? ((meta.seat as string | null) ?? null) : null,
      active: meta ? Boolean(meta.active) : false,
      cash: meta ? Number(meta.cash) : 0,
      startingCash: meta ? Number(meta.starting_cash) : 0,
      nav: nav ? toNullableNumber(nav.nav) : null,
      totalReturn: nav ? toNullableNumber(nav.total_return) : null,
      navDate: nav ? toIsoDate(nav.trade_date) : null,
      openPositions: positionCounts.get(account) ?? 0,
      slots,
    };
  });
}

/** Four small reads, run together. Every query is bounded by the account
 * list (8 rows) or DISTINCT ON, so none of them scales with run history. */
export async function getPaperAccountStatuses(): Promise<PaperAccountStatus[]> {
  const [accounts, runs, nav, positions] = await Promise.all([
    sql`SELECT account, seat, label, active, cash, starting_cash FROM paper_accounts`,
    sql`
      SELECT DISTINCT ON (account, slot)
        account, slot, trade_date, status, skip_reason, orders_n, model_calls, started_at
      FROM paper_runs
      ORDER BY account, slot, trade_date DESC, started_at DESC
    `,
    sql`
      SELECT DISTINCT ON (account) account, trade_date, nav, total_return
      FROM paper_nav
      ORDER BY account, trade_date DESC
    `,
    sql`SELECT account, COUNT(*) AS open_positions FROM paper_positions GROUP BY account`,
  ]);
  return buildPaperAccountStatuses({
    accounts: accounts as Array<Record<string, unknown>>,
    runs: runs as Array<Record<string, unknown>>,
    nav: nav as Array<Record<string, unknown>>,
    positions: positions as Array<Record<string, unknown>>,
  });
}
