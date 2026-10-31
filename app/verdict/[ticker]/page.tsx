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
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import DisclaimerModal from "@/components/DisclaimerModal";
import DisclaimerFooter from "@/components/DisclaimerFooter";
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
      <PreLoginNav />

      <section className="cta" style={{ minHeight: "70vh" }}>
        <div className="wrap">
          <div className="kicker">Council verdict</div>
          <h2>${ticker}</h2>

          {latest ? (
            <>
              <div className="public-demo-result" style={{ maxWidth: 560, margin: "24px auto" }}>
                <p className="public-demo-result-label">
                  {DIRECTION_LABEL[latest.direction ?? ""] ?? "VERDICT"} · {latest.confidence ?? "—"} confidence
                </p>
                <p className="public-demo-result-text">
                  Horizon {latest.horizon ?? "—"}. Invalidation: {latest.invalidation ?? "not recorded"}.
                </p>
              </div>
              <p className="section-copy" style={{ maxWidth: 560, margin: "0 auto 24px" }}>
                Six AI analysts argued this call — including one whose job is to argue against it.
                This is where they landed, and the exact price that would prove them wrong.
              </p>
            </>
          ) : (
            <p className="section-copy" style={{ maxWidth: 560, margin: "24px auto" }}>
              No council verdict recorded for ${ticker} yet. New verdicts publish
              here as the council makes calls.
            </p>
          )}

          <div className="hero-actions">
            <Link className="btn primary" href="/sign-up">
              Start free →
            </Link>
            <Link className="btn secondary" href="/signals">
              Browse the signals
            </Link>
          </div>
          <p className="hero-subtext">Free to start · no card required</p>
        </div>
      </section>

      <PreLoginFooter />

      <DisclaimerModal surface="verdict" />
      <DisclaimerFooter surface="verdict" />
    </div>
  );
}
