import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Portfolio Intelligence — Health Score & Optimizer Suggestions",
  description: "Get a portfolio health score graded A–F with factor-level explanations and actionable suggestions from our AI optimizer. Know where you stand.",
  alternates: { canonical: "/portfolio-intelligence" },
  openGraph: { title: "Portfolio Intelligence · NuWrrrld Financial", description: "A health score for your portfolio, graded A–F." },
};

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

interface IndustryEntry {
  sector?: string;
  etf?: string;
  change_pct?: number;
  returns?: Record<string, number>;
  ai_score?: number;
  ai_action?: string;
}

async function fetchIndustryData() {
  try {
    const res = await fetch(`${MCP_URL}/industry-intel`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const data = await res.json() as { date?: string; industries?: Record<string, IndustryEntry> };
    const industries = data.industries ?? {};
    const sorted = Object.entries(industries)
      .sort(([, a], [, b]) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
    return { date: data.date, topGainers: sorted.slice(0, 5), topLosers: sorted.slice(-5).reverse() };
  } catch { return null; }
}

export default async function PortfolioIntelligenceLandingPage() {
  const industry = await fetchIndustryData();

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

      {industry && (
        <section className="landing-signals-preview">
          <h2>Industry performance <span className="live-badge">Live</span></h2>
          <div className="industry-cols">
            <div>
              <div className="signals-preview-label bullish">Top gainers today</div>
              {industry.topGainers.map(([name, ind]) => (
                <div key={name} className="industry-row">
                  <span className="industry-name">{name}</span>
                  {ind.etf && <span className="industry-etf">{ind.etf}</span>}
                  <span className="sig-conf--bullish industry-pct">+{ind.change_pct?.toFixed(2)}%</span>
                </div>
              ))}
            </div>
            <div>
              <div className="signals-preview-label bearish">Lagging today</div>
              {industry.topLosers.map(([name, ind]) => (
                <div key={name} className="industry-row">
                  <span className="industry-name">{name}</span>
                  {ind.etf && <span className="industry-etf">{ind.etf}</span>}
                  <span className="sig-conf--bearish industry-pct">{ind.change_pct?.toFixed(2)}%</span>
                </div>
              ))}
            </div>
          </div>
          <p className="signals-preview-note">Full factor breakdown and optimizer suggestions available with a Pro account.</p>
        </section>
      )}

      <section className="landing-features">
        {[
          { icon: "🏥", title: "Portfolio health score", body: "An A–F grade derived from multiple factors: concentration risk, sector balance, momentum, and volatility regime." },
          { icon: "📊", title: "Factor breakdown", body: "See exactly which factors are lifting or dragging your score — not just the headline number but the why behind it." },
          { icon: "💡", title: "Optimizer suggestions", body: "Concrete, prioritised suggestions from our AI optimizer. Each one labelled high/medium/low and tied to a specific factor." },
          { icon: "👁️", title: "Watchlists & alerts", body: "Build a watchlist of tickers you're watching. Get signal and price alerts delivered the moment they trigger." },
        ].map(f => (
          <div key={f.title} className="feature-card">
            <span className="feature-icon" aria-hidden="true">{f.icon}</span>
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
