import "../landing-pages.css";
import "./launch.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "NuWrrrld Financial is Live — We Launched Today",
  description: "AI stock signals with plain-language explanations. Portfolio health scoring. Nu AI assistant. 7-day free trial.",
  robots: { index: false }, // Prevent this time-boxed page from diluting SEO
};

const PH_URL = "https://www.producthunt.com/posts/nuwrrrld-financial";

export default function LaunchPage() {
  return (
    <main className="launch-page landing-page">
      <nav className="landing-nav">
        <Link href="/" className="brand">NuWrrrld Financial</Link>
        <Link href="/pricing" className="nav-cta">Start free trial</Link>
      </nav>

      <section className="launch-hero">
        <p className="launch-badge">🚀 We launched today on Product Hunt</p>
        <h1>AI stock signals that explain themselves</h1>
        <p className="landing-sub">
          Every signal tells you which indicators fired, the timeframe, and why it matters —
          so you can decide for yourself. With portfolio health scoring and Nu AI for your questions.
        </p>
        <div className="launch-ctas">
          <a href={PH_URL} target="_blank" rel="noreferrer" className="ph-btn">
            <span aria-hidden="true">🏆</span> Support us on Product Hunt
          </a>
          <Link href="/pricing" className="hero-cta">Start 7-day free trial</Link>
        </div>
        <p className="hero-note">No credit card required · Cancel anytime · Not financial advice</p>
      </section>

      <section className="launch-social">
        <h2>What founders are saying</h2>
        <div className="testimonial-grid">
          {[
            { quote: "Finally a signals app that explains the why, not just the what.", name: "Beta founder" },
            { quote: "Nu AI actually knows my portfolio. That's the killer feature.", name: "Beta founder" },
            { quote: "The health score showed me I was way too concentrated in semis.", name: "Beta founder" },
          ].map((t, i) => (
            <blockquote key={i} className="testimonial">
              <p>&ldquo;{t.quote}&rdquo;</p>
              <footer>— {t.name}</footer>
            </blockquote>
          ))}
        </div>
      </section>

      <section className="landing-cta-block">
        <h2>Support us today</h2>
        <p className="launch-sub">A Product Hunt upvote takes 10 seconds and means a lot to a solo founder.</p>
        <a href={PH_URL} target="_blank" rel="noreferrer" className="ph-btn ph-btn--lg">
          <span aria-hidden="true">🏆</span> Upvote on Product Hunt
        </a>
        <p className="landing-disclaimer">
          <Link href="/terms-of-service">Terms</Link> · <Link href="/privacy-policy">Privacy</Link>
        </p>
      </section>
    </main>
  );
}
