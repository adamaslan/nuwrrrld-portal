import { buildFibLadder, type FibSummary } from "@/lib/shared/fib-levels";

const fmtPrice = (n: number) => n.toFixed(2);
const fmtPct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/** Fibonacci support/resistance ladder for a holdfold analysis. Renders
 *  nothing when the response carried no levels. */
export function FibLadder({ summary }: { summary: FibSummary }) {
  const ladder = buildFibLadder(summary);
  if (!ladder) return null;

  return (
    <div className="hf-fib-ladder" data-testid="fib-ladder">
      <p className="hf-section-label">FIBONACCI LEVELS</p>
      <div className="hf-ind-grid">
        <div className="hf-ind-cell">
          <span className="hf-ind-label">NEAREST SUPPORT</span>
          <span className="hf-ind-val">
            {ladder.support ? `${fmtPrice(ladder.support.price)} (${fmtPct(ladder.support.distancePct)})` : "—"}
          </span>
        </div>
        <div className="hf-ind-cell">
          <span className="hf-ind-label">NEAREST RESISTANCE</span>
          <span className="hf-ind-val">
            {ladder.resistance ? `${fmtPrice(ladder.resistance.price)} (${fmtPct(ladder.resistance.distancePct)})` : "—"}
          </span>
        </div>
      </div>
      <ul className="hf-fib-rows">
        {ladder.rows.map((row) =>
          row.kind === "price" ? (
            <li key="price" className="hf-fib-row hf-fib-price" data-testid="fib-price">
              ▶ Price {fmtPrice(row.price)}
            </li>
          ) : (
            <li key={`${row.name}-${row.price}`} className="hf-fib-row">
              {row.name} · {fmtPrice(row.price)} ({fmtPct(row.distancePct)})
            </li>
          ),
        )}
      </ul>
      {ladder.zones.length > 0 && (
        <p className="hf-fib-zones">
          Confluence zones:{" "}
          {ladder.zones.map((z) => `${fmtPrice(z.price)} (${z.signal_count} signals)`).join(", ")}
        </p>
      )}
    </div>
  );
}
