import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Portfolio Intelligence — Health Score & Optimizer Suggestions",
  description: "Get a portfolio health score graded A–F with factor-level explanations and actionable suggestions from our AI optimizer. Know where you stand.",
  alternates: { canonical: "https://financial.nuwrrrld.com/portfolio-intelligence" },
  openGraph: { title: "Portfolio Intelligence · NuWrrrld Financial", description: "A health score for your portfolio, graded A–F." },
};

export default function PortfolioIntelligenceLandingPage() {
  return (
    <main className="landing-page">
      <nav className="landing-nav">
        <Link href="/" className="brand">NuWrrrld Financial</Link>
        <Link href="/pricing" className="nav-cta">Start free trial</Link>
      </nav>

      <section className="landing-hero">
        <h1>Your portfolio, graded</h1>
        <p className="landing-sub">
          A single health score — graded A through F — tells you where your portfolio stands across risk,
          diversification, and momentum. Paired with concrete, prioritised suggestions from our AI optimizer.
        </p>
        <Link href="/pricing" className="hero-cta">Check your portfolio health free</Link>
        <p className="hero-note">7-day free trial · No credit card required to start</p>
      </section>

      <section className="landing-features">
        {[
          { icon: "🏥", title: "Portfolio health score", body: "An A–F grade derived from multiple factors: concentration risk, sector balance, momentum, and volatility regime." },
          { icon: "📊", title: "Factor breakdown", body: "See exactly which factors are lifting or dragging your score — not just the headline number but the why behind it." },
          { icon: "💡", title: "Optimizer suggestions", body: "Concrete, prioritised suggestions from our AI optimizer. Each one labelled high/medium/low and tied to a specific factor." },
          { icon: "👁️", title: "Watchlists & alerts", body: "Build a watchlist of tickers you're watching. Get signal and price alerts delivered the moment they trigger." },
        ].map(f => (
          <div key={f.title} className="feature-card">
            <span className="feature-icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-cta-block">
        <h2>See your portfolio health score</h2>
        <Link href="/pricing" className="hero-cta">Start free trial</Link>
        <p className="landing-disclaimer">Not financial advice · <Link href="/terms-of-service">Terms</Link> · <Link href="/privacy-policy">Privacy</Link></p>
      </section>
    </main>
  );
}
