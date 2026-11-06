import Link from "next/link";
import { formatRunTimeET } from "@/lib/format-time";
import { summarizeOutcomes } from "@/lib/pipeline-run-log-db";
import type { PipelineName, PipelineRunRow } from "@/lib/pipeline-run-log-db";

/** Presentational rows for the pipeline-runs page. Lives in _components
 * because a Next page module may export only the page and its config. */
/** Human labels for the pipelines this page knows how to render.
 * Partial rather than a full `Record<PipelineName, string>`: `PipelineName`
 * widens ahead of a pipeline actually being wired into this dashboard (see
 * docs/modal-pipeline-status.md Design 1), and `RunRow`'s `?? run.pipeline`
 * fallback already covers the raw name until its label is added here. */
export const PIPELINE_LABEL: Partial<Record<PipelineName, string>> = {
  "followed-tickers": "Followed tickers",
  "followed-tickers-select": "Followed tickers · select",
  "followed-tickers-judge": "Followed tickers · judge",
  "precompute-ai": "Precompute AI",
};

export function RunModeBadge({ dryRun }: { dryRun: boolean }) {
  return (
    <span className={`nld-badge nld-badge--${dryRun ? "blocked" : "pass"}`}>
      {dryRun ? "Dry run" : "Live"}
    </span>
  );
}

export function RunRow({ run }: { run: PipelineRunRow }) {
  const outcomes = summarizeOutcomes(run.items);
  return (
    <tr className="nld-row">
      <td>
        <Link href={`/dashboard/nulogdash/pipelines/${run.id}`}>
          {PIPELINE_LABEL[run.pipeline] ?? run.pipeline}
        </Link>
      </td>
      <td><RunModeBadge dryRun={run.dryRun} /></td>
      <td>{formatRunTimeET(run.runAt)}</td>
      <td>{run.itemsTotal}</td>
      <td>{run.itemsAi}</td>
      <td>
        {outcomes.ok} ok · {outcomes.empty} empty · {outcomes.fail} fail · {outcomes.skip} skip
      </td>
      <td>{run.session ?? "—"}</td>
    </tr>
  );
}
