/**
 * Two-audience explainer block ("New to markets?" / "Trade actively?").
 * Used on every pre-login page: the landing page opens and closes with it,
 * and each feature page carries a deeper version in the same pattern.
 * Copy rule: only live, ungated features may be described here.
 */
export default function TwoAudiences({
  kicker = "Two ways to read it",
  title,
  beginner,
  trader,
}: {
  kicker?: string;
  title: string;
  beginner: { heading: string; paragraphs: string[] };
  trader: { heading: string; paragraphs: string[] };
}) {
  return (
    <section className="landing-two-audiences" style={{ padding: "2rem 0" }}>
      <div className="section-head section-head--solo">
        <div>
          <div className="kicker">{kicker}</div>
          <h2>{title}</h2>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "1.25rem", marginTop: "1.5rem" }}>
        {[
          { label: "New to markets?", data: beginner },
          { label: "Trade actively?", data: trader },
        ].map(({ label, data }) => (
          <article key={label} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: "16px", padding: "1.5rem" }}>
            <h3>{label}</h3>
            <h4 style={{ margin: "0.25rem 0 0.5rem", fontSize: "1rem" }}>{data.heading}</h4>
            {data.paragraphs.map((p, i) => (
              <p key={i} className="section-copy" style={i > 0 ? { fontSize: "0.85rem", opacity: 0.8 } : undefined}>{p}</p>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
