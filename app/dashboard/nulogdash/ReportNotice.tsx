import Link from "next/link";
import type { ReportState } from "@/lib/nulogdash-report";

export function ReportNotice({ state }: { state: Exclude<ReportState, { status: "ready" }> }) {
  return (
    <section className="nld-empty" aria-labelledby="nld-report-state">
      <h2 id="nld-report-state">{state.status === "missing" ? "No feature-sweep report on this server" : "Feature-sweep report unavailable"}</h2>
      <p>{state.status === "missing"
        ? "This console reads a local .nulogdash/latest.json file. A sweep run on another computer does not publish its report here. This is missing evidence, not a failed or passing sweep."
        : "The local report could not be read or validated. It is not being counted as a passing sweep or as proof that no run happened."}</p>
      <p><Link href="/dashboard/nulogdash/pipelines">View recorded pipeline runs</Link>. Pipeline history is a separate data source and may still be available.</p>
      <details><summary>Local report instructions</summary>
        <p>On an approved local checkout, <code>npm run nulogdash</code> creates a local report. Review the command target and model-quota effects before running it. Running it locally does not upload evidence to this deployment.</p>
      </details>
      <p>No pipeline was started and no access settings were changed by opening this page.</p>
    </section>
  );
}
