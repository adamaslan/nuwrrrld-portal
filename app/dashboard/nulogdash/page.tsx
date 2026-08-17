import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getLatestRun, isNulogdashAdmin, canPerformAdminAction, summarizeCounts, splitResults } from "@/lib/nulogdash";
import type { FeatureResult, FeatureStatus } from "@/lib/nulogdash";
import "./nulogdash.css";

export const metadata: Metadata = {
  title: "nulogdash · NuWrrrld Financial",
};

// Always fresh — this page exists to be checked right after a /nulogdash
// run, and cached results would defeat the purpose.
export const dynamic = "force-dynamic";

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
        You can view reports, but actions that change data (impersonate,
        disable, reset password, reindex) stay disabled until you enrol a
        second factor in your account security settings.
      </p>
    </div>
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

export default async function NulogdashPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/nulogdash");

  const user = await currentUser();
  if (!isNulogdashAdmin(user)) notFound();

  // Read-only reports don't require a second factor; mutating actions will.
  // Surfacing it here means an un-enrolled admin learns why the buttons are
  // missing instead of finding out when one silently fails.
  const canMutate = canPerformAdminAction(user);

  const run = getLatestRun();

  if (!run) {
    return (
      <main className="nld-page">
        <Link href="/dashboard" className="nld-back">← Dashboard</Link>
        <h1>nulogdash</h1>
        {!canMutate && <MfaNotice />}
        <p className="nld-empty">
          No run yet. From Claude Code, run <code>/nulogdash</code>, or from a
          terminal: <code>npm run nulogdash</code>.
        </p>
      </main>
    );
  }

  const counts = summarizeCounts(run.results);
  const notExercised = counts.blocked + counts.not_run;
  const total = run.results.length;

  const { notExercised: notExercisedResults, exercised: exercisedResults } = splitResults(run.results);

  // Playwright (scripts/nulogdash-merge-e2e.mjs) merges tier: "browser" rows
  // into the same results array nulogdash.mjs's tier: "api" rows land in —
  // see docs/wiki-portal/entity-playwright-e2e.md. Broken out here only for
  // a quick per-tier read; FeatureRow/StatusBadge already render either tier
  // with no special-casing (run.results.filter never needed elsewhere).
  const browserResults = run.results.filter((r) => r.tier === "browser");
  const browserCounts = summarizeCounts(browserResults);

  return (
    <main className="nld-page">
      <Link href="/dashboard" className="nld-back">← Dashboard</Link>
      <h1>nulogdash</h1>
      <p className="nld-meta">
        Last run {new Date(run.runAt).toLocaleString()} · {run.branch}@{run.gitSha} · {run.baseUrl}
      </p>

      {!canMutate && <MfaNotice />}

      <div className="nld-headline">
        <strong>{notExercised} of {total} features not run end-to-end this pass.</strong>
        <span className="nld-headline-sub">
          {counts.pass} pass · {counts.fail} fail · {counts.blocked} blocked · {counts.not_run} not run
        </span>
        {browserResults.length > 0 && (
          <span className="nld-headline-sub">
            Browser tier (Playwright): {browserCounts.pass} pass · {browserCounts.fail} fail ·{" "}
            {browserCounts.not_run} skipped — run <code>npm run test:e2e:nulogdash</code> to refresh
          </span>
        )}
      </div>

      {run.driftWarnings.length > 0 && (
        <div className="nld-drift">
          <strong>Inventory drift ({run.driftWarnings.length}):</strong>
          <ul>{run.driftWarnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}

      <section>
        <h2>Not run end-to-end</h2>
        {notExercisedResults.length === 0 ? (
          <p className="nld-empty">Everything in scope ran this pass.</p>
        ) : (
          <table className="nld-table">
            <thead><tr><th>Feature</th><th>Status</th><th>Tier</th><th>Latency</th><th>Reason</th></tr></thead>
            <tbody>{notExercisedResults.map((r) => <FeatureRow key={r.feature} result={r} />)}</tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Exercised this pass</h2>
        <table className="nld-table">
          <thead><tr><th>Feature</th><th>Status</th><th>Tier</th><th>Latency</th><th>Reason</th></tr></thead>
          <tbody>{exercisedResults.map((r) => <FeatureRow key={r.feature} result={r} />)}</tbody>
        </table>
      </section>

      {run.excluded.length > 0 && (
        <section>
          <h2>Excluded from sweep</h2>
          <table className="nld-table">
            <thead><tr><th>Feature</th><th>Entry point</th><th>Reason</th></tr></thead>
            <tbody>
              {run.excluded.map((ex) => (
                <tr key={ex.feature}>
                  <td>{ex.feature}</td>
                  <td>{ex.path}</td>
                  <td>{ex.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
