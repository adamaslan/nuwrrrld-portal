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
import TwoAudiences from "@/components/landing/TwoAudiences";
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
    description: `The recorded council call on $${ticker ?? ""}: direction, confidence, horizon, and the invalidation level when one was set.`,
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
                A recorded council call, published as it was made — direction, confidence,
                horizon, and the invalidation level when one was set.
              </p>
            </>
          ) : (
            <p className="section-copy" style={{ maxWidth: 560, margin: "24px auto" }}>
              No council verdict recorded for ${ticker} yet. New verdicts publish
              here when calls are recorded.
            </p>
          )}

          <TwoAudiences
            kicker="Two ways to read it"
            title="How to read this verdict."
            beginner={{
              heading: "The call, the confidence, the exit",
              paragraphs: [
                "The verdict is the council's recorded call - BUY, SELL or HOLD when a direction was set. Confidence says how strongly it leans, and the invalidation price is the level where the call breaks - when those were set.",
              ],
            }}
            trader={{
              heading: "Published per call",
              paragraphs: [
                "Public verdict pages show what was actually recorded per call - direction, confidence, horizon and invalidation, including when a field was never set.",
              ],
            }}
          />

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
