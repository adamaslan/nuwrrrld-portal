import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";
import { adaptLiveSignals, type SignalPayload } from "@/lib/digest";

export const metadata: Metadata = {
  title: "AI Stock Signals — Daily Digest with Explanations",
  description: "Get daily AI-generated stock signals with plain-language explanations. Know not just what the signal is, but why — then decide for yourself.",
  alternates: { canonical: "/signals" },
  openGraph: { title: "AI Stock Signals · NuWrrrld Financial", description: "Daily signals, explained." },
};

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

async function fetchPublicSignals(): Promise<SignalPayload[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/signals`, {
      signal: controller.signal,
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const digest = adaptLiveSignals(await res.json());
    return digest?.signals ?? [];
  } catch { return []; } finally { clearTimeout(timer); }
}

export default async function SignalsLandingPage() {
  const signals = await fetchPublicSignals();
  const topBuy = signals.filter(s => s.direction === "bullish").slice(0, 6);
  const topSell = signals.filter(s => s.direction === "bearish").slice(0, 3);

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

      {(topBuy.length > 0 || topSell.length > 0) && (
        <section className="landing-signals-preview">
          <h2>Today&apos;s signals <span className="live-badge">Live</span></h2>
          {topBuy.length > 0 && (
            <div className="signals-preview-group">
              <div className="signals-preview-label bullish">Bullish</div>
              <div className="signals-preview-grid">
                {topBuy.map(s => (
                  <div key={s.id} className="signals-preview-card">
                    <span className="sig-ticker">{s.ticker}</span>
                    <span className="sig-conf sig-conf--bullish">{s.confidence}</span>
                    <span className="sig-title">{s.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {topSell.length > 0 && (
            <div className="signals-preview-group">
              <div className="signals-preview-label bearish">Bearish</div>
              <div className="signals-preview-grid">
                {topSell.map(s => (
                  <div key={s.id} className="signals-preview-card">
                    <span className="sig-ticker">{s.ticker}</span>
                    <span className="sig-conf sig-conf--bearish">{s.confidence}</span>
                    <span className="sig-title">{s.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <p className="signals-preview-note">Full explanations, indicators, and daily digest available with a Pro account.</p>
        </section>
      )}

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
