import "../landing.css";
import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import TwoAudiences from "@/components/landing/TwoAudiences";
import DisclaimerModal from "@/components/DisclaimerModal";
import DisclaimerFooter from "@/components/DisclaimerFooter";

export const metadata: Metadata = {
  title: "Portfolio Intelligence — Health Score & Optimizer Suggestions",
  description: "Get a portfolio health score graded A–F with factor-level explanations and actionable suggestions from our AI optimizer. Know where you stand.",
  alternates: { canonical: "/portfolio-intelligence" },
  openGraph: { title: "Portfolio Intelligence · NuWrrrld Financial", description: "A health score for your portfolio, graded A–F." },
};

interface IndustryEntry {
  sector?: string;
  etf?: string;
  change_pct?: number;
  returns?: Record<string, number>;
  ai_score?: number;
  ai_action?: string;
}

async function fetchIndustryData() {
  const mcpUrl = process.env.MCP_BACKEND_URL;
  if (!mcpUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${mcpUrl}/industry-intel`, {
      signal: controller.signal,
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = await res.json() as { date?: string; industries?: Record<string, IndustryEntry> };
    const industries = data.industries ?? {};
    const sorted = Object.entries(industries)
      .sort(([, a], [, b]) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
    return { date: data.date, topGainers: sorted.slice(0, 5), topLosers: sorted.slice(-5).reverse() };
  } catch { return null; } finally { clearTimeout(timer); }
}

export default async function PortfolioIntelligenceLandingPage() {
  const industry = await fetchIndustryData();

  return (
    <div className="nwf-landing">
      <PreLoginNav />

      <main className="landing-page">
        <section className="landing-hero">
          <h1>Your portfolio, graded</h1>
          <p className="landing-sub">
            One A-to-F health score across concentration, sector balance, momentum, and volatility —
            plus the specific fixes our optimizer would make first, and the factor behind each one.
          </p>
          <Link href="/sign-up" className="hero-cta">Start free →</Link>
          <p className="hero-note">Free to start · No card required</p>
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
            <p className="signals-preview-note">Full factor breakdown and optimizer suggestions are Pro features.</p>
          </section>
        )}

        <section className="landing-features">
          {[
            { icon: "🏥", title: "Portfolio health score", body: "An A–F grade derived from multiple factors: concentration risk, sector balance, momentum, and volatility regime." },
            { icon: "📊", title: "Factor breakdown", body: "See exactly which factors are lifting or dragging your score — not just the headline number but the why behind it." },
            { icon: "💡", title: "Optimizer suggestions", body: "Concrete, prioritised suggestions from our AI optimizer, each one labelled by impact and tied to a specific factor." },
            { icon: "👁️", title: "Watchlists", body: "Keep a personal watchlist of the tickers you follow, and let Nu AI answer questions grounded in it." },
          ].map(f => (
            <div key={f.title} className="feature-card">
              <span className="feature-icon" aria-hidden="true">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </section>

        <TwoAudiences
          title="Same grade, two ways to use it."
          beginner={{
            heading: "One letter, honestly earned",
            paragraphs: [
              "Your portfolio gets an A-to-F health grade, so a messy collection of positions turns into one clear answer: how healthy is this? Concentration, balance and volatility are explained as you go - no textbook required.",
              "You also see the specific fixes that would help most, in priority order, and the factor behind each one.",
            ],
          }}
          trader={{
            heading: "A grade you can decompose",
            paragraphs: [
              "The score breaks down into concentration risk, sector balance, momentum and volatility regime, and the factor breakdown shows exactly what is lifting or dragging you.",
              "Industry performance is tracked live so you can see which sectors are carrying the market today, and watchlists keep your names close for Nu AI.",
            ],
          }}
        />

        <section className="landing-cta-block">
          <h2>See your portfolio, graded</h2>
          <Link href="/sign-up" className="hero-cta">Start free →</Link>
          <p className="landing-disclaimer">
            Free to start · Pro adds the daily digest, Nu AI, and the morning briefing
          </p>
          <p className="landing-disclaimer">Not financial advice · <Link href="/terms-of-service">Terms</Link> · <Link href="/privacy-policy">Privacy</Link></p>
        </section>

        <DisclaimerModal surface="portfolio" />
        <DisclaimerFooter surface="portfolio" />
      </main>

      <PreLoginFooter />
    </div>
  );
}
