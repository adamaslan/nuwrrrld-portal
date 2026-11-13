/**
 * GET /verdict/[ticker] — public, no-auth page. The share destination behind
 * the OG card (app/api/og/verdict/[ticker]): shows the latest council
 * verdict for a ticker (if one exists) plus a sign-up CTA for full history.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { recentVerdicts } from "@/lib/council-db";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import TwoAudiences from "@/components/landing/TwoAudiences";
import DisclaimerModal from "@/components/DisclaimerModal";
import DisclaimerFooter from "@/components/DisclaimerFooter";
import { isVerdictIndexable, verdictDescription, verdictTitle } from "@/lib/verdict-seo";
import "../../landing.css";

// Verdicts change a few times a day at most; cache each ticker page for an hour.
export const revalidate = 3600;

// generateMetadata and the page both need the latest verdict; one query each render.
const latestVerdict = cache(async (ticker: string) => (await recentVerdicts(ticker, 1))[0] ?? null);

interface Props {
  params: Promise<{ ticker: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker: raw } = await params;
  const ticker = normalizeTicker(raw);
  if (!ticker) return { title: "Verdict", robots: { index: false, follow: false } };
  const latest = await latestVerdict(ticker);
  const title = verdictTitle(ticker, latest);
  const description = verdictDescription(ticker, latest);
  const ogImage = `/api/og/verdict/${ticker}`;
  return {
    title,
    description,
    alternates: { canonical: `/verdict/${ticker}` },
    // A ticker with no recorded verdict is a thin page: keep it out of the index.
    robots: { index: isVerdictIndexable(latest), follow: true },
    openGraph: { title, description, images: [{ url: ogImage, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [ogImage] },
  };
}

const DIRECTION_LABEL: Record<string, string> = { bullish: "BUY", bearish: "SELL", neutral: "HOLD" };

export default async function VerdictPage({ params }: Props) {
  const { ticker: raw } = await params;
  const ticker = normalizeTicker(raw);
  if (!ticker) notFound();

  const latest = await latestVerdict(ticker);

  return (
    <div className="nwf-landing">
      <PreLoginNav />

      <section className="cta public-verdict">
        <div className="wrap">
          <div className="kicker">Council verdict</div>
          <h1>${ticker}</h1>

          {latest ? (
            <>
              <div className="public-demo-result verdict-record">
                <p className="public-demo-result-label">
                  {DIRECTION_LABEL[latest.direction ?? ""] ?? "VERDICT"} · {latest.confidence ?? "—"} confidence
                </p>
                <p className="public-demo-result-text">
                  Horizon {latest.horizon ?? "—"}. Invalidation: {latest.invalidation ?? "not recorded"}.
                </p>
              </div>
              <p className="section-copy verdict-description">
                A recorded council call, published as it was made — direction, confidence,
                horizon, and the invalidation level when one was set.
              </p>
            </>
          ) : (
            <p className="section-copy verdict-description">
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
