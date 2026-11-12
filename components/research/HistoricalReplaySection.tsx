import type { ReplayBucket, ReplayReadResult } from "@/lib/shared/historical-replay-view";

const VISIBLE_ROWS = 25;

/**
 * Labelled research view of a reconstructed (point-in-time replay) run.
 * Pure: renders whatever the validated reader returned; it never fetches, never
 * implies a live track record, and shows unsupported/partial/null states as such.
 */
export function HistoricalReplaySection({ result }: { result: ReplayReadResult }) {
  return (
    <section className="hrp" aria-labelledby="hrp-title">
      <h1 id="hrp-title">Historical replay (reconstructed research)</h1>
      <Body result={result} />
    </section>
  );
}

function Body({ result }: { result: ReplayReadResult }) {
  if (result.status === "not_computed") {
    return <p className="hrp-note">No replay artifact has been loaded. Nothing is shown rather than guessing.</p>;
  }
  if (result.status === "invalid_run") {
    return (
      <p className="hrp-alert" role="alert">
        The replay artifact failed validation and is not shown ({result.reason}).
      </p>
    );
  }
  const v = result.view;
  const statusCounts = new Map<string, number>();
  const flagged = new Map<string, string[]>();
  for (const row of v.coverage) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    if (row.status !== "ok") flagged.set(row.status, [...(flagged.get(row.status) ?? []), row.ticker]);
  }
  const flaggedTotal = [...flagged.values()].reduce((n, t) => n + t.length, 0);
  const declared = new Map(v.bases.map((b) => [b.id, b]));
  const bases = [...new Set(v.buckets.map((b) => b.basis))].sort();
  return (
    <>
      <p className="hrp-label" role="note">{v.label}. Research only: not a production prior, and council and judge history are not available.</p>
      {result.status === "partial" && (
        <p className="hrp-note">
          Partial coverage: {v.complete} of {v.requested} symbols are calendar-complete. The other {flaggedTotal} are listed by status in the disclosure under Coverage and are excluded from pooled results.
        </p>
      )}
      <p className="hrp-meta">
        Decisions {v.decisionStart} to {v.observationCutoff} (outcomes capped at the cutoff). Computed {v.computedAt.slice(0, 10)}.
      </p>

      <h2>Coverage</h2>
      <dl className="hrp-grid">
        <div><dt>Requested</dt><dd>{v.requested}</dd></div>
        <div><dt>Complete</dt><dd>{v.complete}</dd></div>
        <div><dt>Partial</dt><dd>{v.partial}</dd></div>
        <div><dt>Missing</dt><dd>{v.missing}</dd></div>
        <div><dt>Errors</dt><dd>{v.errors}</dd></div>
        <div><dt>Unsupported</dt><dd>{v.unsupported}</dd></div>
      </dl>
      <ul className="hrp-status" aria-label="Rows by status">
        {[...statusCounts.entries()].sort().map(([status, n]) => (
          <li key={status}>{status.replace(/_/g, " ")}: {n}</li>
        ))}
      </ul>
      {flaggedTotal > 0 && (
        <details className="hrp-more">
          <summary>Show the {flaggedTotal} symbols that are not calendar-complete (ticker and status)</summary>
          {[...flagged.entries()].sort().map(([status, tickers]) => (
            <div key={status} className="hrp-flagged">
              <h3>{status.replace(/_/g, " ")} ({tickers.length})</h3>
              <p>{[...tickers].sort().join(", ")}</p>
            </div>
          ))}
          <p className="hrp-note">Calendar-complete symbols are counted above but not listed here.</p>
        </details>
      )}

      <h2>Price bases</h2>
      <p className="hrp-note">Calendar: {v.priceBasis.calendarPolicy}. {v.basisPolicy}</p>
      <ul className="hrp-bases" aria-label="Declared price bases">
        {v.bases.map((b) => (
          <li key={b.id}><strong>{b.id}</strong>: {b.source}; adjustment: {b.adjustment}</li>
        ))}
      </ul>
      <p className="hrp-note">
        {v.mixedInputBasis
          ? "Mixed price bases: each table below is one declared basis, and results are never pooled across bases."
          : "One declared price basis; each table below is that basis."}
      </p>

      <h2>Pooled outcomes</h2>
      {bases.length === 0 && <p className="hrp-note">No pooled buckets were produced.</p>}
      {bases.map((basis) => {
        const rows = v.buckets
          .filter((b) => b.basis === basis)
          .sort((x, y) => y.resolved - x.resolved || x.category.localeCompare(y.category) || x.strength.localeCompare(y.strength) || x.horizonBars - y.horizonBars);
        const head = rows.slice(0, VISIBLE_ROWS);
        const rest = rows.slice(VISIBLE_ROWS);
        const d = declared.get(basis);
        return (
          <div key={basis} className="hrp-basis">
            <h3>
              {basis}
              {d && <span className="hrp-basis-decl"> · {d.source}; adjustment: {d.adjustment}</span>}
            </h3>
            <p className="hrp-note">{rows.length} buckets, largest {head.length} by resolved count shown first.</p>
            <OutcomeTable basis={basis} rows={head} />
            {rest.length > 0 && (
              <details className="hrp-more">
                <summary>Show the other {rest.length} buckets for {basis}</summary>
                <OutcomeTable basis={`${basis} (remaining)`} rows={rest} />
              </details>
            )}
          </div>
        );
      })}
    </>
  );
}

function OutcomeTable({ basis, rows }: { basis: string; rows: ReplayBucket[] }) {
  return (
    <div className="hrp-scroll" role="region" aria-label={`Outcomes for ${basis}`} tabIndex={0}>
      <table>
        <caption className="hrp-sr">Resolved outcomes by signal category, strength and horizon for {basis}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th><th scope="col">Strength</th><th scope="col">Horizon (bars)</th>
            <th scope="col">Resolved</th><th scope="col">Hits</th><th scope="col">Misses</th>
            <th scope="col">Flat</th><th scope="col">Pending</th><th scope="col">Hit rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={`${b.category}|${b.strength}|${b.horizonBars}`}>
              <th scope="row">{b.category}</th><td>{b.strength}</td><td>{b.horizonBars}</td>
              <td>{b.resolved}</td><td>{b.hits}</td><td>{b.misses}</td><td>{b.flat}</td><td>{b.pending}</td>
              <td>{b.hitRate === null ? "n<30, not shown" : `${(b.hitRate * 100).toFixed(1)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
