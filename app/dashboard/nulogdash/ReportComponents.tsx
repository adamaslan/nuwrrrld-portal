import Link from "next/link";
import type { FeatureResult, FeatureStatus } from "@/lib/nulogdash";
import type { QualityEvidence } from "@/lib/nulogdash-quality.mjs";

const STATUS_LABEL: Record<FeatureStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  blocked: "Blocked",
  not_run: "Not run",
};

/** Shown to an allowlisted admin who hasn't enrolled a second factor. The
 * console stays readable; only mutating actions are withheld.
 * Kept outside the Next page module so it can be tested independently. */
export function MfaNotice() {
  return (
    <div className="nld-mfa-notice">
      <strong>Two-factor authentication required for admin actions.</strong>
      <p>
        You can view reports, but actions that spend model quota or write rows
        (triggering a pipeline run) stay disabled until you enrol a second
        factor in your account security settings.
      </p>
    </div>
  );
}

/** Tab strip shared with /dashboard/nulogdash/pipelines. Lives here because
 * the feature sweep is the console's root. */
export function NulogdashTabs({ active }: { active: "sweep" | "pipelines" | "beta" }) {
  return (
    <nav className="nld-tabs" aria-label="nulogdash sections">
      <Link
        href="/dashboard/nulogdash"
        className={`nld-tab${active === "sweep" ? " nld-tab--active" : ""}`}
        aria-current={active === "sweep" ? "page" : undefined}
      >
        Feature sweep
      </Link>
      <Link
        href="/dashboard/nulogdash/pipelines"
        className={`nld-tab${active === "pipelines" ? " nld-tab--active" : ""}`}
        aria-current={active === "pipelines" ? "page" : undefined}
      >
        Pipeline runs
      </Link>
      <Link
        href="/dashboard/nulogdash/beta"
        className={`nld-tab${active === "beta" ? " nld-tab--active" : ""}`}
        aria-current={active === "beta" ? "page" : undefined}
      >
        Beta testers
      </Link>
    </nav>
  );
}

export function StatusBadge({ status }: { status: FeatureStatus }) {
  return <span className={`nld-badge nld-badge--${status}`}>{STATUS_LABEL[status]}</span>;
}

export function FeatureRow({ result }: { result: FeatureResult }) {
  return (
    <tr className={`nld-row nld-row--${result.status}`}>
      <td>{result.label}</td>
      <td><StatusBadge status={result.status} /></td>
      <td>{result.tier ?? "—"}</td>
      <td>{result.latencyMs !== null ? `${result.latencyMs}ms` : "—"}</td>
      <td>
        {result.reason ? (
          <details className="nld-reason">
            <summary>{result.reason.length > 60 ? `${result.reason.slice(0, 60)}…` : result.reason}</summary>
            <p>{result.reason}</p>
          </details>
        ) : "—"}
      </td>
    </tr>
  );
}

const QUALITY_LABEL: Record<string, string> = {
  measured: "Measured", meets_target: "Meets target", misses_target: "Misses target",
  insufficient: "Insufficient evidence", blocked: "Blocked", missing: "Not recorded",
};

const qualityValue = (value: number | null | undefined) =>
  value === null || value === undefined ? "Not recorded" : String(value);

function metricDimensions(metric: QualityEvidence["metrics"][number]) {
  const dimensions = metric.dimensions;
  if (!dimensions) return "Horizon, window, slice, and scorer version not recorded.";
  const parts = [
    dimensions.horizonDays === null ? null : `${dimensions.horizonDays}-session horizon`,
    dimensions.windowSessions === null ? null : `${dimensions.windowSessions}-session window`,
    dimensions.sliceKind && dimensions.sliceValue ? `${dimensions.sliceKind}: ${dimensions.sliceValue}` : null,
    dimensions.scorerVersion,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Horizon, window, slice, and scorer version not recorded.";
}

export function QualityEvidencePanel({ quality }: { quality: QualityEvidence }) {
  const workload = quality.workload;
  return (
    <section className="nld-quality" aria-labelledby="nld-quality-title">
      <h2 id="nld-quality-title">Quality evidence</h2>
      {quality.displayReason && <p className="nld-quality-note">{quality.displayReason}</p>}
      <dl className="nld-quality-meta">
        <div><dt>Source</dt><dd>{quality.source.name ?? "Not recorded"}</dd></div>
        <div><dt>Source version</dt><dd>{quality.source.version ?? "Not recorded"}</dd></div>
        <div><dt>Source run</dt><dd>{quality.source.runId ?? "Not recorded"}</dd></div>
        <div><dt>Evaluator</dt><dd>{quality.source.evaluatorVersion ?? "Not recorded"}</dd></div>
        <div><dt>Cutoff</dt><dd>{quality.cutoffAt ?? "Not recorded"}</dd></div>
      </dl>
      <p className="nld-quality-scope">{quality.evidenceScope}</p>
      <div className="nld-quality-workload">
        <strong>Useful workload coverage</strong>
        <span>{QUALITY_LABEL[workload.verdict] ?? "Not recorded"}</span>
        <span>{qualityValue(workload.useful)} useful / {qualityValue(workload.eligible)} eligible</span>
        <span>{qualityValue(workload.attempted)} attempted · {qualityValue(workload.skipped)} skipped · {qualityValue(workload.deferred)} deferred · {qualityValue(workload.errors)} errors</span>
        {workload.reason && <p>{workload.reason}</p>}
      </div>
      {quality.metrics.length === 0 ? <p className="nld-empty">No quality metrics were recorded.</p> : (
        <>
          <p className="nld-quality-scroll-hint">Scroll the metrics table horizontally to see targets and evidence status.</p>
          <div className="nld-quality-scroll" role="region" aria-label="Quality metrics, horizontally scrollable" tabIndex={0}>
            <table className="nld-table nld-quality-table">
              <thead><tr><th>Metric / dimensions</th><th>Observed</th><th>Measured / eligible</th><th>Target and rationale</th><th>Evidence status</th></tr></thead>
              <tbody>{quality.metrics.map((metric) => (
                <tr key={metric.id}>
                  <td>{metric.label}<small>{metricDimensions(metric)}</small></td>
                  <td>{metric.valueState === "null" ? "NULL" : qualityValue(metric.observed)}</td>
                  <td>{qualityValue(metric.measuredDenominator)} / {qualityValue(metric.eligibleDenominator)}</td>
                  <td>{metric.target.value === null ? "No numeric target specified" : `${metric.target.operator === ">=" ? "≥" : "≤"} ${metric.target.value}`}<small>{metric.target.rationale}</small></td>
                  <td><span className={`nld-quality-verdict nld-quality-verdict--${metric.verdict}`}>{QUALITY_LABEL[metric.verdict ?? "missing"] ?? "Not recorded"}</span>{metric.reason && <small>{metric.reason}</small>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
