import Link from "next/link";
import type { FeatureResult, FeatureStatus } from "@/lib/nulogdash";

/** Presentational chrome shared by the nulogdash pages. Lives in _components
 * because a Next page module may export only the page and its config -
 * component exports from a page file fail the production build. */
const STATUS_LABEL: Record<FeatureStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  blocked: "Blocked",
  not_run: "Not run",
};

/** Shown to an allowlisted admin who hasn't enrolled a second factor. The
 * console stays readable; only mutating actions are withheld.
 * Exported for component tests — plain function returning JSX, no
 * `async`/server dependency, so it renders normally under jsdom. */
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
 * the feature sweep is the console's root; the pipelines page imports it. */
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
