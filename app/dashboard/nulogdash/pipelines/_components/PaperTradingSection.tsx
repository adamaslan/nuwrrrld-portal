import type { RunStatus, Slot } from "@/lib/paper-db";
import type { PaperAccountStatus, SlotRunStatus } from "@/lib/paper-status-db";
import { PAPER_SLOTS } from "@/lib/paper-status-db";

/** RunStatus → the existing .nld-badge colour classes. A degraded run is a
 * warning (amber), a skip is informational, a failure is red. */
const STATUS_BADGE: Record<RunStatus, string> = {
  ok: "pass",
  degraded: "blocked",
  skipped: "not_run",
  failed: "fail",
};

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const PCT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 2, signDisplay: "exceptZero" });

export function SlotChip({ slot, run }: { slot: Slot; run: SlotRunStatus | null }) {
  if (!run) {
    return (
      <li className="nld-slot">
        <span className="nld-slot-name">{slot}</span>
        <span className="nld-badge nld-badge--not_run">Never run</span>
      </li>
    );
  }
  const detail = [
    run.tradeDate,
    run.ordersN != null ? `${run.ordersN} orders` : null,
    run.modelCalls > 0 ? `${run.modelCalls} model calls` : null,
    run.skipReason,
  ].filter(Boolean).join(" · ");
  return (
    <li className="nld-slot">
      <span className="nld-slot-name">{slot}</span>
      <span className={`nld-badge nld-badge--${STATUS_BADGE[run.status]}`}>{run.status}</span>
      <span className="nld-card-sub">{detail}</span>
    </li>
  );
}

/** One simulated account: its book, its latest mark, and each slot's last run. */
export function PaperAccountCard({ status }: { status: PaperAccountStatus }) {
  return (
    <article className="nld-card nld-account" aria-label={`${status.label} paper account`}>
      <div className="nld-account-head">
        <strong>{status.label}</strong>
        <code className="nld-account-key">{status.account}</code>
        {!status.active && <span className="nld-badge nld-badge--not_run">Inactive</span>}
      </div>
      <span className="nld-card-sub">
        {status.nav != null
          ? `NAV ${USD.format(status.nav)}${status.totalReturn != null ? ` · ${PCT.format(status.totalReturn)}` : ""} · ${status.navDate}`
          : "No mark-to-market yet"}
      </span>
      <span className="nld-card-sub">
        {status.openPositions} open {status.openPositions === 1 ? "position" : "positions"} · cash {USD.format(status.cash)}
      </span>
      <ul className="nld-slots">
        {PAPER_SLOTS.map((slot, i) => (
          <SlotChip key={slot} slot={slot} run={status.slots[i]} />
        ))}
      </ul>
    </article>
  );
}

/** The paper-trading category: every simulated account, each slot's latest
 * run. Trading accounts first, then the two controls (equal, spy). */
export function PaperTradingSection({ statuses }: { statuses: PaperAccountStatus[] }) {
  return (
    <section aria-labelledby="nld-paper-heading">
      <h2 id="nld-paper-heading">Paper trading</h2>
      <p className="nld-meta">
        Eight simulated $10,000 accounts (council seats plus equal-weight and buy-and-hold baselines).
        Each slot shows the latest run the engine recorded. No real money, no broker.
      </p>
      <div className="nld-cards nld-cards--accounts">
        {statuses.map((s) => (
          <PaperAccountCard key={s.account} status={s} />
        ))}
      </div>
    </section>
  );
}
