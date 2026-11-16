import { existsSync } from "node:fs";
import { formatRunTimeET } from "@/lib/format-time";
import { join } from "node:path";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { isNulogdashAdmin } from "@/lib/nulogdash";
import { NulogdashTabs } from "../../ReportComponents";
import { ItemRow } from "../ItemComponents";
import { getPipelineRun, summarizeOutcomes } from "@/lib/pipeline-run-log-db";
import type { PerModelStats } from "@/lib/pipeline-run-log-db";
import "../../nulogdash.css";

export const metadata: Metadata = {
  title: "nulogdash · pipeline run",
};

export const dynamic = "force-dynamic";

/** The on-disk HTML report for this run, if `scripts/pipeline-run-report.mjs`
 * generated one locally. The filename is deterministic — the same
 * `${ISO(run_at)}-${pipeline}` base that script writes (see its final lines) —
 * so no directory scan is needed. Absent on any deploy (the folder is
 * gitignored and never built), hence the dev-only guard and the
 * `existsSync` check. Returns the absolute path as text rather than a link:
 * browsers block `file://` navigation from an http page, and the page is not
 * served under a route. */
function localReportPath(runAt: string, pipeline: string): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const base = `${new Date(runAt).toISOString().replace(/[:.]/g, "-")}-${pipeline}`;
  const abs = join(process.cwd(), "docs", "pipeline-runs", `${base}.html`);
  return existsSync(abs) ? abs : null;
}

export default async function PipelineRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const { userId } = await auth();
  if (!userId) redirect(`/sign-in?redirect_url=/dashboard/nulogdash/pipelines/${id}`);

  const user = await currentUser();
  if (!isNulogdashAdmin(user)) notFound();

  const run = await getPipelineRun(id);
  if (!run) notFound();

  const outcomes = summarizeOutcomes(run.items);
  const models = Object.entries(run.models) as [string, PerModelStats][];
  const reportPath = localReportPath(run.runAt, run.pipeline);

  return (
    <main className="nld-page">
      <Link href="/dashboard/nulogdash/pipelines" className="nld-back">← Pipeline runs</Link>
      <h1>{run.pipeline}</h1>
      <NulogdashTabs active="pipelines" />
      <p className="nld-meta">
        {formatRunTimeET(run.runAt)} · {run.dryRun ? "dry run" : "live run"} ·{" "}
        session {run.session ?? "—"} · <code>{run.id}</code>
      </p>

      {run.dryRun && (
        <div className="nld-note">
          <strong>Dry run.</strong> No model was called and nothing was written by
          this run — every item is recorded as <code>skip</code> by design.
        </div>
      )}

      {reportPath && (
        <p className="nld-meta">
          Generated HTML report on disk (local only):{" "}
          <code>open {reportPath}</code>
        </p>
      )}

      <div className="nld-cards">
        <div className="nld-card">
          <span className="nld-card-label">Items</span>
          <strong>{run.itemsTotal}</strong>
          <span className="nld-card-sub">{run.itemsAi} spent a model call</span>
        </div>
        <div className="nld-card">
          <span className="nld-card-label">Ok</span><strong>{outcomes.ok}</strong>
        </div>
        <div className="nld-card">
          <span className="nld-card-label">Empty</span><strong>{outcomes.empty}</strong>
        </div>
        <div className="nld-card">
          <span className="nld-card-label">Failed</span><strong>{outcomes.fail}</strong>
        </div>
        <div className="nld-card">
          <span className="nld-card-label">Skipped</span><strong>{outcomes.skip}</strong>
        </div>
      </div>

      <section>
        <h2>Per model</h2>
        {models.length === 0 ? (
          <p className="nld-empty">No model served in this run.</p>
        ) : (
          <div className="nld-table-wrap">
          <table className="nld-table">
            <thead>
              <tr><th>Model</th><th>Calls</th><th>Empty</th><th>Fallbacks</th><th>Avg latency</th></tr>
            </thead>
            <tbody>
              {models.map(([model, s]) => (
                <tr key={model} className="nld-row">
                  <td>{model}</td>
                  <td>{s.calls}</td>
                  <td>{s.empty}</td>
                  <td>{s.fallbacks}</td>
                  <td>{s.avgLatencyMs !== null ? `${s.avgLatencyMs}ms` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>

      <section>
        <h2>Items ({run.items.length})</h2>
        {run.items.length === 0 ? (
          <p className="nld-empty">This run recorded no items.</p>
        ) : (
          <div className="nld-table-wrap">
          <table className="nld-table">
            <thead>
              <tr><th>Subject</th><th>Seat</th><th>Model</th><th>Outcome</th><th>Latency</th><th>Fallback</th></tr>
            </thead>
            <tbody>{run.items.map((it, i) => <ItemRow key={`${it.subject}-${i}`} item={it} />)}</tbody>
          </table>
          </div>
        )}
      </section>

      <section>
        <h2>Raw summary</h2>
        <pre className="nld-pre">{JSON.stringify(run.summary, null, 2)}</pre>
      </section>
    </main>
  );
}
