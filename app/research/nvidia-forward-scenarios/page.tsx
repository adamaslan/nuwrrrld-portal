import { IchimokuChart } from "./IchimokuChart";
import type { Metadata } from "next";
import Link from "next/link";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import article from "@/lib/research/nvidia-scenarios.json";
import "@/app/landing.css";
import "./research.css";

export const metadata: Metadata = {
  title: "NVIDIA: six forward-looking checkpoints | Research dated November 13, 2026",
  description: "Conditional NVIDIA scenarios for one week and 1, 3, 6, 9 and 12 months. Historical scan inputs through November 12, 2026. Not predictions or probabilities.",
  alternates: { canonical: "/research/nvidia-forward-scenarios" },
  openGraph: {
    title: "NVIDIA scenarios | Research dated November 13, 2026",
    description: "Six conditional horizons. Frozen November 12 technical context, not a live signal or investment recommendation.",
  },
};

/** Static public research. No account access, live quotes, model calls or database queries. */
export default function NvidiaScenariosPage() {
  return <div className="nwf-landing">
    <PreLoginNav />
    <main className="nvda-research">
      <header>
        <p className="kicker">Research note · November 13, 2026</p>
        <h1>NVIDIA: six forward-looking checkpoints</h1>
        <p>{article.intro}</p>
        <aside className="nvda-note" aria-label="Research limitations">
          <strong>Scenarios, not predictions.</strong> One week and 1, 3, 6, 9 and 12 months. Conditional paths, not ranked probabilities or price targets. Historical scan inputs stop on November 12, 2026. This is dated research, not a live quote or an investment recommendation.
        </aside>
      </header>
      <IchimokuChart />
      <section aria-labelledby="starting-point"><h2 id="starting-point">The starting point</h2>{article.opening.map((p,i)=><p key={i}>{p}</p>)}</section>
      <p className="nvda-caption">Checkpoint dates use calendar time from November 13, 2026. Weekend dates are review markers, not exchange sessions. None is a promised reporting date.</p>
      <nav className="nvda-horizons" aria-label="Article horizons">{article.scenarios.map((s,i)=><a key={s.horizon} href={`#horizon-${i+1}`}>{s.horizon}</a>)}</nav>
      {article.scenarios.map((s,i)=><section key={s.horizon} aria-labelledby={`horizon-${i+1}`}>
        <p className="kicker">{s.horizon} · {s.date}</p><h2 id={`horizon-${i+1}`}>{s.focus}</h2>
        <h3>Upside path</h3><p>{s.up}</p><h3>Continuity path</h3><p>{s.middle}</p><h3>Downside path</h3><p>{s.down}</p>
        <aside className="nvda-note"><strong>What changes the view</strong><p>{s.check}</p></aside>
      </section>)}
      <section aria-labelledby="scan-method"><h2 id="scan-method">What the scan did and did not do</h2>{article.method.map((p,i)=><p key={i}>{p}</p>)}</section>
      <section aria-labelledby="takeaway"><h2 id="takeaway">Read the evidence by horizon</h2>{article.closing.map((p,i)=><p key={i}>{p}</p>)}</section>
      <section aria-labelledby="sources"><h2 id="sources">Source notes</h2><ol className="nvda-sources">{article.sources.map(s=><li key={s[0]}><a href={s[2]} target="_blank" rel="noopener noreferrer">{s[1]}</a><p>{s[3]}</p></li>)}</ol></section>
      <p className="nvda-caption">Facts checked November 13, 2026. Educational research, not personalized investment advice. No trade, target price or probability is implied. The dates and technical context do not update automatically.</p>
      <Link href="/">Back to the public landing page</Link>
    </main>
    <PreLoginFooter />
  </div>;
}
