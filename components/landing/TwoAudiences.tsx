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
    <section className="landing-two-audiences">
      <div className="section-head section-head--solo">
        <div>
          <div className="kicker">{kicker}</div>
          <h2>{title}</h2>
        </div>
      </div>
      <div className="audience-paths">
        {[
          { label: "New to markets?", data: beginner },
          { label: "Trade actively?", data: trader },
        ].map(({ label, data }) => (
          <article key={label} className="audience-path">
            <h3>{label}</h3>
            <h4 className="audience-heading">{data.heading}</h4>
            {data.paragraphs.map((p, i) => (
              <p key={i} className={i > 0 ? "section-copy audience-detail" : "section-copy"}>{p}</p>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
