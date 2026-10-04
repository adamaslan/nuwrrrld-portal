import type { CatalogEntry } from "@/lib/nulogdash-catalog";
import type { PipelineRunRow } from "@/lib/pipeline-run-log-db";
import { summarizeOutcomes } from "@/lib/pipeline-run-log-db";

/** Run evidence line. A catalog entry with no `pipeline` writes no
 * pipeline_run_log row, so the honest answer is to say so rather than
 * imply a missing run. */
function EvidenceLine({ entry, latestRun }: { entry: CatalogEntry; latestRun: PipelineRunRow | null }) {
  if (!entry.pipeline) {
    return <span className="nld-card-sub">No run log row — check the GitHub Actions run history.</span>;
  }
  if (!latestRun) {
    return <span className="nld-card-sub">No run recorded in pipeline_run_log yet.</span>;
  }
  const outcomes = summarizeOutcomes(latestRun.items);
  return (
    <span className="nld-card-sub">
      Last recorded {new Date(latestRun.runAt).toLocaleString()} ·{" "}
      {latestRun.dryRun ? "dry run" : "live"} · {outcomes.ok} ok · {outcomes.fail} fail
    </span>
  );
}

/** One scheduled workload — a GHA workflow or a Modal app — with its trigger,
 * latest recorded run, and sub-features (jobs or functions) folded under a
 * disclosure so a phone screen stays readable. */
export function ScheduledWorkCard({
  entry,
  latestRun,
}: {
  entry: CatalogEntry;
  latestRun: PipelineRunRow | null;
}) {
  return (
    <article className="nld-card nld-work" aria-label={entry.label}>
      <strong>{entry.label}</strong>
      <span className="nld-card-sub">{entry.trigger}</span>
      <EvidenceLine entry={entry} latestRun={latestRun} />
      <details className="nld-subfeatures">
        <summary>{entry.subFeatures.length} sub-features</summary>
        <ul>
          {entry.subFeatures.map((f) => (
            <li key={f.label}>
              <code>{f.label}</code> — {f.detail}
            </li>
          ))}
        </ul>
      </details>
      <code className="nld-source">{entry.source}</code>
    </article>
  );
}

/** A category of scheduled work: GitHub Actions or Modal. `latestRunFor`
 * resolves the evidence row for an entry; the page supplies it from the runs
 * it already loaded so no extra query runs here. */
export function ScheduledWorkSection({
  id,
  title,
  description,
  entries,
  latestRunFor,
}: {
  id: string;
  title: string;
  description: string;
  entries: readonly CatalogEntry[];
  latestRunFor: (entry: CatalogEntry) => PipelineRunRow | null;
}) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <p className="nld-meta">{description}</p>
      <div className="nld-cards nld-cards--work">
        {entries.map((entry) => (
          <ScheduledWorkCard key={entry.id} entry={entry} latestRun={latestRunFor(entry)} />
        ))}
      </div>
    </section>
  );
}
