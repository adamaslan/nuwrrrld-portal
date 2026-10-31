import { getStoredSignals } from "@/app/dashboard/holdfold/stored-signals";
import "../landing.css";
import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";
import { adaptLiveSignals, type SignalPayload } from "@/lib/digest";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import TwoAudiences from "@/components/landing/TwoAudiences";
import DisclaimerModal from "@/components/DisclaimerModal";
import DisclaimerFooter from "@/components/DisclaimerFooter";

export const metadata: Metadata = {
  title: "AI Stock Signals — Daily Digest with Explanations",
  description: "Get daily AI-generated stock signals with plain-language explanations. Know not just what the signal is, but why — then decide for yourself.",
  alternates: { canonical: "/signals" },
  openGraph: { title: "AI Stock Signals · NuWrrrld Financial", description: "Daily signals, explained." },
};

async function fetchPublicSignals(): Promise<SignalPayload[]> {
  return adaptLiveSignals(await getStoredSignals()).signals;
}

export default async function SignalsLandingPage() {
  const signals = await fetchPublicSignals();
  const topBuy = signals.filter(s => s.direction === "bullish").slice(0, 6);
  const topSell = signals.filter(s => s.direction === "bearish").slice(0, 3);

  return (
    <div className="nwf-landing">
      <PreLoginNav />

      <main className="landing-page">
        <section className="landing-hero">
          <h1>Stock signals that explain themselves</h1>
          <p className="landing-sub">
            Five independent signal families check every call. Each one comes with a confidence level
            and a plain-English explanation of what fired, on what timeframe, and why it matters.
            You decide what to do with it.
          </p>
          <Link href="/sign-up" className="hero-cta">Start free →</Link>
          <p className="hero-note">Free to start · No card required</p>
        </section>

        {(topBuy.length > 0 || topSell.length > 0) && (
          <section className="landing-signals-preview">
            <h2>Stored signals <span className="live-badge">Latest stored</span></h2>
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
            <p className="signals-preview-note">Full explanations, indicators, and the daily digest are Pro features.</p>
          </section>
        )}

        <section className="landing-features">
          {[
            { icon: "📈", title: "Ranked calls, every day", body: "Bullish, bearish, and hold calls across the tracked universe, ranked by confidence and refreshed every trading day." },
            { icon: "🔍", title: "Explainability first", body: "Each signal names the indicators that fired — RSI, MACD, volume, trend — in plain language, not jargon." },
            { icon: "🎯", title: "A confidence level on every signal", body: "Every signal carries a confidence level, so you know how much to lean on it before you act." },
            { icon: "💬", title: "Ask any call a question", body: "Open a signal and ask \"why now?\" or \"what would change your mind?\" — answers grounded in that ticker's real data." },
          ].map(f => (
            <div key={f.title} className="feature-card">
              <span className="feature-icon" aria-hidden="true">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </section>

        <TwoAudiences
          title="Same signals, two ways to read them."
          beginner={{
            heading: "A heads-up, not homework",
            paragraphs: [
              "A signal is a heads-up that our models see something worth watching in a stock or ETF. Each one is labelled bullish or bearish - the direction the models lean - and explains its reasoning in plain language, so you learn while you look.",
              "The confidence level on each signal tells you how much weight the models give it. Nothing here requires you to act.",
            ],
          }}
          trader={{
            heading: "Five families, one ranked list",
            paragraphs: [
              "Five independent signal families check every call, ranked by confidence and refreshed every trading day. Each signal names the indicators that fired - RSI, MACD, volume, trend - and the timeframe it fired on.",
              "Open any signal and interrogate it with Ask Anything: why now, or what would change your mind, answered from that ticker's real data. Pro adds the daily digest by email.",
            ],
          }}
        />

        <section className="landing-cta-block">
          <h2>Start watching the signals today</h2>
          <Link href="/sign-up" className="hero-cta">Start free →</Link>
          <p className="landing-disclaimer">
            Free to start · Pro adds the daily digest, Nu AI, and the morning briefing
          </p>
          <p className="landing-disclaimer">Not financial advice · <Link href="/terms-of-service">Terms</Link> · <Link href="/privacy-policy">Privacy</Link></p>
        </section>

        <DisclaimerModal surface="signals" />
        <DisclaimerFooter surface="signals" />
      </main>

      <PreLoginFooter />
    </div>
  );
}
