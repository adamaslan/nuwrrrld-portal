/** An illustrative reading guide, never a fabricated live result. */
const examples = {
  signals: { title: "Read a signal in context", rows: [["Direction", "Bullish, bearish or hold"], ["Confidence", "Read the model's strength of evidence"], ["Explanation", "Check the indicators and timeframe"]] },
  portfolio: { title: "Look beneath the grade", rows: [["Health score", "A-to-F overview"], ["Factors", "Concentration, sectors, momentum, volatility"], ["Next step", "Review suggestions before making a decision"]] },
  assistant: { title: "Ask the next question", rows: [["You ask", "What is driving this portfolio's risk?"], ["Evidence", "Your holdings and today's signals"], ["Limit", "No connected holdings means no portfolio context"]] },
  paper: { title: "Follow a simulated decision", rows: [["Record", "Published calls and paper positions"], ["Outcome", "Inspect the recorded result and costs"], ["Limit", "Simulated trading, not real money"]] },
  record: { title: "A rank is the beginning", rows: [["History", "Check how much data supports the rank"], ["Method", "Paper-book or followed universe"], ["Limit", "Past results do not guarantee future returns"]] },
} as const;

export default function ProductExample({ kind }: { kind: keyof typeof examples }) {
  const example = examples[kind];
  return <figure className="feature-example">
    <figcaption>Illustrative reading guide - not live data or a recommendation</figcaption>
    <h2>{example.title}</h2>
    <dl>{example.rows.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>
  </figure>;
}
