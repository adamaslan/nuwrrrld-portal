import type { Metadata } from "next";
import Link from "next/link";
import "../landing.css";
import "../landing-pages.css";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import TwoAudiences from "@/components/landing/TwoAudiences";

export const metadata: Metadata = {"title": "Paper trading, without real money | NuWrrrld Financial", "description": "Watch the council put its ideas into simulated portfolios. Six AI-seat books and two control books make it easier to see how different approaches behave. These are practice strategies, not brokerage accounts.", "alternates": {"canonical": "/paper-trading"}};

export default function Page() {
  return (
    <div className="nwf-landing">
      <PreLoginNav />
      <main className="landing-page">
        <section className="landing-hero">
          <h1>{"Paper trading, without real money"}</h1>
          <p className="landing-sub">{"Watch the council put its ideas into simulated portfolios. Six AI-seat books and two control books make it easier to see how different approaches behave. These are practice strategies, not brokerage accounts."}</p>
          <Link href="/pricing" className="hero-cta">See Pro access →</Link>
        </section>
        <TwoAudiences title="Understand the record before following the rank" beginner={{"heading": "Learn by following a practice portfolio", "paragraphs": ["See what each AI-managed book holds, when it trades, and how its recorded value changes. No real money is placed at risk by these simulated orders.", "You are observing the app's simulated books. This is not a tool for entering your own practice orders, and it does not connect to a broker."]}} trader={{"heading": "Compare construction, not just calls", "paragraphs": ["The paper portfolio view exposes holdings, recent orders, portfolio value, total return and drawdown when data is available. The arena groups holdings across the books so you can inspect overlap and differences.", "Six seat-specific strategies sit alongside two control books. Sharpe, daily-return and benchmark-relative figures are currently withheld while their validation is completed."]}} />
        <section className="landing-features">
          {[{"title": "Eight books, different approaches", "body": "Short-term, long-term, risk, macro, quantitative and Chair books, plus two controls. The books start with simulated $10,000, not a real deposit."}, {"title": "A visible trading record", "body": "Inspect recorded positions, recent orders and portfolio-value history. Empty or incomplete history is shown as such, not filled with invented results."}, {"title": "Pro access", "body": "Paper Portfolios and the arena are Pro features in the signed-in app. This page explains them without requiring an account."}].map(c => (
            <article className="feature-card" key={c.title}><h2>{c.title}</h2><p>{c.body}</p></article>
          ))}
        </section>
        <section className="landing-cta-block"><h2>Inspect the record yourself</h2><p>Pro access is required in the app. No real orders are placed by paper portfolios.</p><Link className="hero-cta" href="/dashboard/council/portfolios">Open Paper Portfolios →</Link><p><Link className="feature-more" href="/track-record">Explore top performers and track record →</Link></p></section>
        <p className="hero-note">For research and education, not investment advice. Past or simulated performance does not guarantee future results.</p>
      </main>
      <PreLoginFooter />
    </div>
  );
}
