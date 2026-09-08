import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { isNulogdashAdmin, canPerformAdminAction } from "@/lib/nulogdash";
import { NulogdashTabs } from "../page";
import { TriggerControls } from "./_components/TriggerControls";
import { listPipelineRuns, summarizeOutcomes } from "@/lib/pipeline-run-log-db";
import type { PipelineRunRow } from "@/lib/pipeline-run-log-db";
import "../nulogdash.css";

export const metadata: Metadata = {
  title: "nulogdash · pipeline runs",
};

// Same reasoning as the parent page: this is checked immediately after firing
// a pipeline, so a cached list would show the run that came before.
export const dynamic = "force-dynamic";

const PIPELINES = ["followed-tickers", "followed-tickers-judge", "precompute-ai"] as const;

/** The three pipelines' human labels — kept here rather than in the DB module
 * because they are presentation, and the union there is the contract. */
const PIPELINE_LABEL: Record<(typeof PIPELINES)[number], string> = {
  "followed-tickers": "Followed tickers",
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
      <td>{new Date(run.runAt).toLocaleString()}</td>
      <td>{run.itemsTotal}</td>
      <td>{run.itemsAi}</td>
      <td>
        {outcomes.ok} ok · {outcomes.empty} empty · {outcomes.fail} fail · {outcomes.skip} skip
      </td>
      <td>{run.session ?? "—"}</td>
    </tr>
  );
}

const PAGE_SIZES = [50, 100, 200] as const;
const DEFAULT_PAGE_SIZE = 50;

export default async function PipelineRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ limit?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/nulogdash/pipelines");

  const user = await currentUser();
  if (!isNulogdashAdmin(user)) notFound();

  // Read is gated by isNulogdashAdmin; triggering a run additionally needs MFA
  // (docs/admin-console-todo.md §5.2). The Server Actions re-check this — the
  // flag here only decides whether to render the controls at all.
  const canTrigger = canPerformAdminAction(user);

  // listPipelineRuns already clamps to 1–200; this only picks the request size.
  const parsedLimit = Number.parseInt((await searchParams).limit ?? "", 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_PAGE_SIZE;

  const runs = await listPipelineRuns(limit);
  const latestByPipeline = new Map(
    PIPELINES.map((p) => [p, runs.find((r) => r.pipeline === p) ?? null] as const),
  );

  return (
    <main className="nld-page">
      <Link href="/dashboard/nulogdash" className="nld-back">← nulogdash</Link>
      <h1>Pipeline runs</h1>
      <NulogdashTabs active="pipelines" />
      <p className="nld-meta">
        Every row `pipeline_run_log` holds, newest first — the same table{" "}
        <code>scripts/pipeline-run-report.mjs</code> renders one run of.{" "}
        {canTrigger
          ? "Dry-run buttons are on each card below; a live run needs a typed confirmation and is rate-limited."
          : "Read-only here — firing a pipeline is either the buttons (admins with 2FA) or "}
        {!canTrigger && <code>node scripts/local-trigger.mjs C &lt;workflow&gt; --local</code>}
        {!canTrigger && "."}
      </p>

      <div className="nld-cards">
        {PIPELINES.map((p) => {
          const latest = latestByPipeline.get(p) ?? null;
          return (
            <div key={p} className="nld-card">
              <span className="nld-card-label">{PIPELINE_LABEL[p]}</span>
              {latest ? (
                <>
                  <strong>{new Date(latest.runAt).toLocaleString()}</strong>
                  <span className="nld-card-sub">
                    <RunModeBadge dryRun={latest.dryRun} /> · {latest.itemsTotal} items ·{" "}
                    {latest.itemsAi} AI
                  </span>
                </>
              ) : (
                <>
                  <strong>Never run</strong>
                  <span className="nld-card-sub">No row in pipeline_run_log yet.</span>
                </>
              )}
              {canTrigger && <TriggerControls pipeline={p} />}
            </div>
          );
        })}
      </div>

      <section>
        <h2>Recent runs</h2>
        <p className="nld-meta">
          Showing up to {limit}.{" "}
          {PAGE_SIZES.map((n, i) => (
            <span key={n}>
              {i > 0 && " · "}
              {n === limit ? (
                <strong>{n}</strong>
              ) : (
                <Link href={`/dashboard/nulogdash/pipelines?limit=${n}`}>{n}</Link>
              )}
            </span>
          ))}
        </p>
        {runs.length === 0 ? (
          <p className="nld-empty">
            No pipeline has run against this database yet. Fire one with{" "}
            <code>node scripts/local-trigger.mjs C track-followed-tickers --local</code>.
          </p>
        ) : (
          <table className="nld-table">
            <thead>
              <tr>
                <th>Pipeline</th><th>Mode</th><th>Run at</th><th>Items</th>
                <th>AI calls</th><th>Outcomes</th><th>Session</th>
              </tr>
            </thead>
            <tbody>{runs.map((r) => <RunRow key={r.id} run={r} />)}</tbody>
          </table>
        )}
      </section>
    </main>
  );
}
