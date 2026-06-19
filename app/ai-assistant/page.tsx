import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Nu AI — Personal Finance AI Assistant Powered by Your Portfolio",
  description: "Ask Nu AI anything about your portfolio, signals, or market concepts. Answers grounded in your actual holdings — not generic advice.",
  alternates: { canonical: "https://financial.nuwrrrld.com/ai-assistant" },
  openGraph: { title: "Nu AI Finance Assistant · NuWrrrld Financial", description: "AI that knows your actual portfolio." },
};

export default function AIAssistantLandingPage() {
  return (
    <main className="landing-page">
      <nav className="landing-nav">
        <Link href="/" className="brand">NuWrrrld Financial</Link>
        <Link href="/pricing" className="nav-cta">Start free trial</Link>
      </nav>

      <section className="landing-hero">
        <h1>An AI assistant that knows your portfolio</h1>
        <p className="landing-sub">
          Nu AI answers in the context of your actual holdings, not generic market commentary.
          Ask about your positions, signals, or any financial concept — and get a grounded, honest answer.
        </p>
        <Link href="/pricing" className="hero-cta">Try Nu AI free for 7 days</Link>
        <p className="hero-note">Pro feature · No credit card required to start</p>
      </section>

      <section className="landing-features">
        {[
          { icon: "💼", title: "Portfolio-aware answers", body: "Nu AI reads your connected Schwab holdings before answering. Questions about your specific positions get specific answers." },
          { icon: "🧠", title: "Powered by Claude", body: "Built on Anthropic's Claude — one of the most capable and honest AI models available, with built-in safety guardrails." },
          { icon: "🔒", title: "Never stores your data", body: "Conversations aren't stored or used to train models. Your financial context stays in your session only." },
          { icon: "⚖️", title: "Honest about limits", body: "Nu AI tells you when it doesn't know, and never pretends to give personalised investment advice. Information only." },
        ].map(f => (
          <div key={f.title} className="feature-card">
            <span className="feature-icon">{f.icon}</span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
        ))}
      </section>

      <section className="landing-cta-block">
        <h2>Ask your first question today</h2>
        <Link href="/pricing" className="hero-cta">Start free trial</Link>
        <p className="landing-disclaimer">Not financial advice · <Link href="/terms-of-service">Terms</Link> · <Link href="/privacy-policy">Privacy</Link></p>
      </section>
    </main>
  );
}
