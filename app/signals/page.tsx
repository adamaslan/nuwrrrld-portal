import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "AI Stock Signals — Daily Digest with Explanations",
  description: "Get daily AI-generated stock signals with plain-language explanations. Know not just what the signal is, but why — then decide for yourself.",
  alternates: { canonical: "/signals" },
  openGraph: { title: "AI Stock Signals · NuWrrrld Financial", description: "Daily signals, explained." },
};

export default function SignalsLandingPage() {
  return (
    <main className="landing-page">
      <nav className="landing-nav">
        <Link href="/" className="brand">NuWrrrld Financial</Link>
        <Link href="/pricing" className="nav-cta">Start free trial</Link>
      </nav>

      <section className="landing-hero">
        <h1>Stock signals that explain themselves</h1>
        <p className="landing-sub">
          Every signal comes with a plain-language explanation — which indicators fired, what timeframe, and why it matters.
          You decide what to do with it.
        </p>
        <Link href="/pricing" className="hero-cta">Start 7-day free trial</Link>
        <p className="hero-note">No credit card required to start · Cancel anytime</p>
      </section>

      <section className="landing-features">
        {[
          { icon: "📈", title: "Daily digest", body: "Bullish and bearish signals across your watchlist, ranked by confidence and delivered every morning." },
          { icon: "🔍", title: "Explainability first", body: "Each signal names the indicators that fired — RSI, MACD, volume, trend — in plain language, not jargon." },
          { icon: "⚡", title: "Two optimizers, one view", body: "Our AI and optimizer engines run in parallel. You see a merged, deduplicated view of every opportunity they agree on." },
          { icon: "🔔", title: "Watchlist alerts", body: "Set price and signal thresholds per ticker. Get notified the moment a signal fires, not hours later." },
        ].map(f => (
          <div key={f.title} className="feature-card">
            <span className="feature-icon" aria-hidden="true">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-cta-block">
        <h2>Start your free trial today</h2>
        <Link href="/pricing" className="hero-cta">See pricing</Link>
        <p className="landing-disclaimer">Not financial advice · <Link href="/terms-of-service">Terms</Link> · <Link href="/privacy-policy">Privacy</Link></p>
      </section>
    </main>
  );
}
