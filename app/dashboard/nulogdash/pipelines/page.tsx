import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { isNulogdashAdmin, canPerformAdminAction } from "@/lib/nulogdash";
import { NulogdashTabs } from "../page";
import { TriggerControls } from "./_components/TriggerControls";
import { PaperTradingSection } from "./_components/PaperTradingSection";
import { ScheduledWorkSection } from "./_components/ScheduledWorkSection";
import { listPipelineRuns, summarizeOutcomes } from "@/lib/pipeline-run-log-db";
import type { PipelineName, PipelineRunRow } from "@/lib/pipeline-run-log-db";
import { getPaperAccountStatuses } from "@/lib/paper-status-db";
import { GITHUB_WORKFLOW_CATALOG, MODAL_APP_CATALOG } from "@/lib/nulogdash-catalog";
import type { CatalogEntry } from "@/lib/nulogdash-catalog";
import "../nulogdash.css";

export const metadata: Metadata = {
  title: "nulogdash · pipeline runs",
};

// Same reasoning as the parent page: this is checked immediately after firing
// a pipeline, so a cached list would show the run that came before.
export const dynamic = "force-dynamic";

const PIPELINES = [
  "followed-tickers",
  "followed-tickers-select",
  "followed-tickers-judge",
  "precompute-ai",
] as const;

/** Human labels for the pipelines this page knows how to render.
 * Partial rather than a full `Record<PipelineName, string>`: `PipelineName`
 * widens ahead of a pipeline actually being wired into this dashboard (see
 * docs/modal-pipeline-status.md Design 1), and `RunRow`'s `?? run.pipeline`
 * fallback already covers the raw name until its label is added here. */
const PIPELINE_LABEL: Partial<Record<PipelineName, string>> = {
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
const MAX_PAGE_SIZE = 200; // must match the clamp in listPipelineRuns

/** Jump links for the category sections. On a phone the page is long; this
 * row is how you get from the top to, say, Modal without scrolling past every
 * paper account. */
const CATEGORY_LINKS = [
  { href: "#model-pipelines", label: "Model pipelines" },
  { href: "#paper-trading", label: "Paper trading" },
  { href: "#github-actions", label: "GitHub Actions" },
  { href: "#modal", label: "Modal" },
  { href: "#recent-runs", label: "Recent runs" },
] as const;

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

  // Clamp to the same 1–MAX_PAGE_SIZE window listPipelineRuns enforces, so the
  // "Showing up to N" label never claims more rows than the query can return.
  const parsedLimit = Number.parseInt((await searchParams).limit ?? "", 10);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  const [runs, paperStatuses] = await Promise.all([
    listPipelineRuns(limit),
    getPaperAccountStatuses(),
  ]);
  const latestByPipeline = new Map(
    PIPELINES.map((p) => [p, runs.find((r) => r.pipeline === p) ?? null] as const),
  );
  // Scheduled-work evidence reuses the runs already loaded above, so the
  // GHA and Modal sections add no query of their own.
  const latestRunFor = (entry: CatalogEntry): PipelineRunRow | null =>
    entry.pipeline ? (runs.find((r) => r.pipeline === entry.pipeline) ?? null) : null;

  return (
    <main className="nld-page">
      <Link href="/dashboard/nulogdash" className="nld-back">← nulogdash</Link>
      <h1>Pipeline runs</h1>
      <NulogdashTabs active="pipelines" />
      <p className="nld-meta">
        Every scheduled workload and what it last recorded, by category. Model
        pipelines write <code>pipeline_run_log</code>; paper accounts write{" "}
        <code>paper_runs</code> and <code>paper_nav</code>.{" "}
        {canTrigger
          ? "Dry-run buttons are on each model-pipeline card; a live run needs a typed confirmation and is rate-limited."
          : "Read-only here — firing a pipeline is either the buttons (admins with 2FA) or "}
        {!canTrigger && <code>node scripts/local-trigger.mjs C &lt;workflow&gt; --local</code>}
        {!canTrigger && "."}
      </p>

      <nav className="nld-jump" aria-label="Pipeline categories">
        {CATEGORY_LINKS.map((c) => (
          <a key={c.href} href={c.href} className="nld-tab">{c.label}</a>
        ))}
      </nav>

      <section id="model-pipelines" aria-labelledby="model-pipelines-heading">
        <h2 id="model-pipelines-heading">Model pipelines</h2>
        <p className="nld-meta">Spend model quota. Each card is the latest row in <code>pipeline_run_log</code>.</p>
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
      </section>

      <div id="paper-trading">
        <PaperTradingSection statuses={paperStatuses} />
      </div>

      <div id="github-actions">
        <ScheduledWorkSection
          id="github-actions-heading"
          title="GitHub Actions"
          description={`${GITHUB_WORKFLOW_CATALOG.length} workflows in .github/workflows. Schedules are UTC; manual runs use workflow_dispatch.`}
          entries={GITHUB_WORKFLOW_CATALOG}
          latestRunFor={latestRunFor}
        />
      </div>

      <div id="modal">
        <ScheduledWorkSection
          id="modal-heading"
          title="Modal"
          description={`${MODAL_APP_CATALOG.length} apps under deploy/. Modal has no run log of its own; a recorded run appears only where the app writes pipeline_run_log.`}
          entries={MODAL_APP_CATALOG}
          latestRunFor={latestRunFor}
        />
      </div>

      <section id="recent-runs" aria-labelledby="recent-runs-heading">
        <h2 id="recent-runs-heading">Recent runs</h2>
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
          <div className="nld-table-wrap">
            <table className="nld-table">
              <thead>
                <tr>
                  <th>Pipeline</th><th>Mode</th><th>Run at</th><th>Items</th>
                  <th>AI calls</th><th>Outcomes</th><th>Session</th>
                </tr>
              </thead>
              <tbody>{runs.map((r) => <RunRow key={r.id} run={r} />)}</tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
