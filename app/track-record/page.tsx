import type { Metadata } from "next";
import Link from "next/link";
import "../landing-pages.css";
import "../landing.css";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import ProductExample from "@/components/landing/ProductExample";
import TwoAudiences from "@/components/landing/TwoAudiences";
import RecordedOutcomes from "@/components/landing/RecordedOutcomes";
import { getPublicTrackRecord } from "@/lib/public-track-record-db";

// Aggregate counts only; an hour of staleness is fine and keeps the public
// page off the database for most requests.
export const revalidate = 3600;

export const metadata: Metadata = {"title": "Top performers need a record | NuWrrrld Financial", "description": "A confident call is a claim. A recorded outcome gives you something to check. Follow simulated portfolio leaders and the app's strongest monthly stock calls as two different kinds of evidence.", "alternates": {"canonical": "/track-record"}};

export default async function Page() {
  const record = await getPublicTrackRecord();
  return (
    <div className="nwf-landing">
      <PreLoginNav />
      <main className="landing-page">
        <section className="landing-hero">
          <h1>{"Top performers need a record"}</h1>
          <p className="landing-sub">{"A confident call is a claim. A recorded outcome gives you something to check. Follow simulated portfolio leaders and the app's strongest monthly stock calls as two different kinds of evidence."}</p>
          <Link href="/pricing" className="hero-cta">See Pro access →</Link>
        </section>

        <RecordedOutcomes record={record} />

        <ProductExample kind="record" />
        <TwoAudiences title="Understand the record before following the rank" beginner={{"heading": "Two ways to see what happened", "paragraphs": ["The paper leaderboard compares AI-managed practice portfolios. Followed Tickers tracks the app's strongest bullish and bearish calls from each monthly group.", "A top-ranked book is a simulated result. A strongest call is selected for conviction, not because it is known to become a winner. Neither promises what happens next."]}} trader={{"heading": "Separate portfolio results from pick outcomes", "paragraphs": ["The paper leaderboard shows recorded portfolio values and returns, with positions and orders behind each book. Followed Tickers freezes ten bullish and ten bearish calls per monthly cohort and scores realized price outcomes across seven horizons.", "Reasoning grades are separate from price outcomes. Small unresolved samples and unavailable measurements should stay visible as gaps. Benchmark-relative paper metrics are currently withheld."]}} />
        <section className="landing-features">
          {[{"title": "Paper-book leaderboard", "body": "Compare recorded results from simulated strategies. Inspect the holdings and orders behind the rank rather than treating rank as a recommendation."}, {"title": "Frozen monthly picks", "body": "Followed Tickers keeps the original monthly group fixed so later outcomes do not quietly replace the original calls."}, {"title": "Limits matter", "body": "Historical or simulated results are not future returns. Both signed-in track-record surfaces require Pro access."}].map(c => (
            <article className="feature-card" key={c.title}><h2>{c.title}</h2><p>{c.body}</p></article>
          ))}
        </section>
        <section className="landing-cta-block"><h2>Inspect the record yourself</h2><p>Pro access is required in the app. No real orders are placed by paper portfolios.</p><Link className="hero-cta" href="/dashboard/followed-tickers">Open Followed Tickers →</Link><p><Link className="feature-more" href="/paper-trading">Explore paper trading →</Link></p></section>
        <p className="hero-note">For research and education, not investment advice. Past or simulated performance does not guarantee future results.</p>
      </main>
      <PreLoginFooter />
    </div>
  );
}
