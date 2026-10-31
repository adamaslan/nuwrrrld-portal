import "../landing.css";
import "../landing-pages.css";
import type { Metadata } from "next";
import Link from "next/link";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";

export const metadata: Metadata = {
  title: "Nu AI — Personal Finance AI Assistant Powered by Your Portfolio",
  description: "Ask Nu AI anything about your portfolio, signals, or market concepts. Answers grounded in your actual holdings — not generic advice.",
  alternates: { canonical: "/ai-assistant" },
  openGraph: { title: "Nu AI Finance Assistant · NuWrrrld Financial", description: "AI that knows your actual portfolio." },
};

export default function AIAssistantLandingPage() {
  return (
    <div className="nwf-landing">
      <PreLoginNav />

      <main className="landing-page">
        <section className="landing-hero">
          <h1>An AI assistant that knows your portfolio</h1>
          <p className="landing-sub">
            Nu AI answers in the context of your actual holdings and today&apos;s signals, not generic
            market commentary. Ask about a position, a call, or any market concept, answered in plain English.
          </p>
          <Link href="/sign-up" className="hero-cta">Start free →</Link>
          <p className="hero-note">Nu AI is a Pro feature · 7-day Pro trial available</p>
        </section>

        <section className="landing-features">
          {[
            { icon: "💼", title: "Portfolio-aware answers", body: "Questions about your positions get specific answers, grounded in your holdings, watchlist, and the latest signals." },
            { icon: "🧭", title: "Grounded, not generic", body: "Answers reference your real portfolio and signal data — not a generic chatbot's guess about the market." },
            { icon: "💬", title: "Ask Anything, per ticker", body: "Open any signal and chat with it directly. Streaming answers built on that ticker's live data." },
            { icon: "⚖️", title: "Honest about limits", body: "Nu AI is built to say when it's not sure, and to stay informational rather than give personalised investment advice." },
          ].map(f => (
            <div key={f.title} className="feature-card">
              <span className="feature-icon" aria-hidden="true">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </section>

        <section className="landing-cta-block">
          <h2>Ask your first question today</h2>
          <Link href="/sign-up" className="hero-cta">Start free →</Link>
          <p className="landing-disclaimer">
            Free to start · Pro adds the daily digest, Nu AI, and the morning briefing
          </p>
          <p className="landing-disclaimer">Not financial advice · <Link href="/terms-of-service">Terms</Link> · <Link href="/privacy-policy">Privacy</Link></p>
        </section>
      </main>

      <PreLoginFooter />
    </div>
  );
}
