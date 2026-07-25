/**
 * GET /verdict/[ticker] — public, no-auth page. The share destination behind
 * the OG card (app/api/og/verdict/[ticker]): shows the latest council
 * verdict for a ticker (if one exists) plus a sign-up CTA for full history.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { recentVerdicts } from "@/lib/council-db";
import "../../landing.css";

interface Props {
  params: Promise<{ ticker: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker: raw } = await params;
  const ticker = normalizeTicker(raw);
  const title = ticker ? `$${ticker} — 6 AI analysts, one call` : "Verdict";
  const ogImage = ticker ? `/api/og/verdict/${ticker}` : undefined;
  return {
    title,
    description: `See what six AI analysts — including one whose job is to argue against it — think about $${ticker ?? ""}.`,
    openGraph: ogImage ? { images: [{ url: ogImage, width: 1200, height: 630 }] } : undefined,
    twitter: ogImage ? { card: "summary_large_image", images: [ogImage] } : undefined,
  };
}

const DIRECTION_LABEL: Record<string, string> = { bullish: "BUY", bearish: "SELL", neutral: "HOLD" };

export default async function VerdictPage({ params }: Props) {
  const { ticker: raw } = await params;
  const ticker = normalizeTicker(raw);
  if (!ticker) notFound();

  const [latest] = await recentVerdicts(ticker, 1);

  return (
    <div className="nwf-landing">
      <nav className="topbar" aria-label="Primary navigation">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">NWF</span>
          <span>NuWrrrld Financial</span>
        </Link>
        <div className="navlinks">
          <Link className="nav-keep" href="/sign-in">Sign in</Link>
          <Link className="nav-action" href="/sign-up">Start free →</Link>
        </div>
      </nav>

      <section className="cta" style={{ minHeight: "70vh" }}>
        <div className="wrap">
          <div className="kicker">Council verdict</div>
          <h2>${ticker}</h2>

          {latest ? (
            <div className="public-demo-result" style={{ maxWidth: 560, margin: "24px auto" }}>
              <p className="public-demo-result-label">
                {DIRECTION_LABEL[latest.direction ?? ""] ?? "VERDICT"} · {latest.confidence ?? "—"} confidence
              </p>
              <p className="public-demo-result-text">
                Horizon {latest.horizon ?? "—"}. Invalidation: {latest.invalidation ?? "not recorded"}.
              </p>
            </div>
          ) : (
            <p className="section-copy" style={{ maxWidth: 560, margin: "24px auto" }}>
              No council verdict recorded for ${ticker} yet — ask the council on the
              home page and be the first.
            </p>
          )}

          <div className="hero-actions">
            <Link className="btn primary" href="/sign-up">
              Sign up to see full history
            </Link>
            <Link className="btn secondary" href="/">
              Ask about another ticker
            </Link>
          </div>
        </div>
      </section>

      <footer>
        <span>NWF · NuWrrrld Financial</span>
        <span>Six AI analysts. One straight answer.</span>
      </footer>
    </div>
  );
}
