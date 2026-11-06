import type { RunItem, RunItemOutcome } from "@/lib/pipeline-run-log-db";

/** Presentational rows for the pipeline-run detail page. Lives in _components
 * because a Next page module may export only the page and its config. */
/** Maps a run item's outcome onto the badge classes nulogdash.css already
 * defines, so this page adds no parallel colour vocabulary. */
const OUTCOME_BADGE: Record<RunItemOutcome, string> = {
  ok: "pass",
  empty: "blocked",
  fail: "fail",
  skip: "not_run",
};

export function OutcomeBadge({ outcome }: { outcome: RunItemOutcome }) {
  return <span className={`nld-badge nld-badge--${OUTCOME_BADGE[outcome]}`}>{outcome}</span>;
}

export function ItemRow({ item }: { item: RunItem }) {
  return (
    <tr className="nld-row">
      <td>{item.subject}</td>
      <td>{item.seat ?? "—"}</td>
      <td>{item.model ?? "—"}</td>
      <td><OutcomeBadge outcome={item.outcome} /></td>
      <td>{typeof item.latencyMs === "number" ? `${item.latencyMs}ms` : "—"}</td>
      <td>{item.fallback ? "yes" : "—"}</td>
    </tr>
  );
}
