import type { PublicTrackRecord } from "@/lib/public-track-record";

function pct(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}

function signedPct(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/**
 * Recorded Followed Tickers outcomes, every horizon, misses included.
 * Server component: takes already-aggregated counts, renders no tickers.
 */
export default function RecordedOutcomes({ record }: { record: PublicTrackRecord | null }) {
  if (!record) {
    return (
      <section className="record-outcomes" aria-labelledby="record-outcomes-title">
        <h2 id="record-outcomes-title">Recorded outcomes</h2>
        <p>
          No scored outcomes are available right now. A rate is only shown once enough calls have
          resolved, so an empty table here means the record is still building, not that it is hidden.
        </p>
      </section>
    );
  }

  return (
    <section className="record-outcomes" aria-labelledby="record-outcomes-title">
      <h2 id="record-outcomes-title">Recorded outcomes</h2>
      <p>
        Every scored call from the monthly Followed Tickers groups, hits and misses together.
        Calls that landed inside the flat band, and calls that could not be priced, are counted
        separately instead of dropped. A hit-rate appears only once a horizon has at least{" "}
        {record.minForRate} decisive calls.
      </p>
      <div className="record-table-wrap">
        <table className="record-table">
          <caption>
            {record.totalScored} scored calls across {record.horizons.length} horizons
            {record.latestResolvedOn ? `, latest resolved ${record.latestResolvedOn}` : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Horizon</th>
              <th scope="col">Hits</th>
              <th scope="col">Misses</th>
              <th scope="col">Flat</th>
              <th scope="col">Unpriced</th>
              <th scope="col">Hit-rate</th>
              <th scope="col">Mean directional return</th>
            </tr>
          </thead>
          <tbody>
            {record.horizons.map((h) => (
              <tr key={h.horizon}>
                <th scope="row">{h.label}</th>
                <td>{h.hits}</td>
                <td>{h.misses}</td>
                <td>{h.flats}</td>
                <td>{h.voids}</td>
                <td>{h.hitRatePct == null ? `n=${h.decisive}, too few` : pct(h.hitRatePct)}</td>
                <td>{signedPct(h.meanDirectionalPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="record-note">
        Directional return counts a bearish call as a gain when the price falls. Benchmark-relative
        figures are not shown, because a verified benchmark comparison is not yet available. This is
        a record of past calls, not a forecast.
      </p>
    </section>
  );
}
