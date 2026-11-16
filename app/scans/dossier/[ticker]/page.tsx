/**
 * GET /scans/dossier/[ticker] — B2 momentum-entry dossier from stored Alpaca SIP daily bars, with the
 * G3 "How do we know?" drawer and the G9 provenance footer. Deterministic, no model call (C0).
 * Short or malformed history renders as missing; it is never filled in.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceBadge } from "@/components/evidence/EvidenceBadge";
import { ProvenanceFooter } from "@/components/evidence/ProvenanceFooter";
import { loadSeries } from "@/lib/engine-db";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { momentumEntryDossier, type Bar, type MomentumDossier } from "@/lib/shared/se1/dossiers";
import { howWeKnow } from "@/lib/shared/se1/explain";
import { daysBetween } from "@/lib/shared/se1/util";
import "../../scans.css";

export const revalidate = 3600;

const FEED = "sip" as const;
const MAX_BARS = 260;
const STALE_AFTER_DAYS = 4;
const MOMENTUM_SCAN_VERSION = "b2-momentum-1";

interface Props { params: Promise<{ ticker: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ticker = normalizeTicker((await params).ticker);
  return { title: ticker ? `${ticker} momentum dossier` : "Momentum dossier", robots: { index: false, follow: true } };
}

async function loadBars(ticker: string): Promise<{ bars: Bar[] } | { error: string }> {
  try {
    const [series] = await loadSeries([ticker], FEED, MAX_BARS);
    if (!series) return { bars: [] };
    return { bars: series.dates.map((date, i) => ({ date, close: Number(series.bars[i].close) })) };
  } catch (error) {
    console.error("[scans/dossier] daily_bars read failed", { ticker, error: error instanceof Error ? error.message : String(error) });
    return { error: "Stored daily bars could not be read right now." };
  }
}

export default async function MomentumDossierPage({ params }: Props) {
  const ticker = normalizeTicker((await params).ticker);
  if (!ticker) notFound();
  const loaded = await loadBars(ticker);
  const dossier: MomentumDossier = "error" in loaded
    ? { status: "missing", reason: loaded.error }
    : momentumEntryDossier(loaded.bars);
  const today = new Date().toISOString().slice(0, 10);
  const ageDays = dossier.status === "ok" ? daysBetween(dossier.as_of, today) : null;
  const provenance = dossier.status === "ok"
    ? { source: "daily_bars (Alpaca)", feed: FEED, as_of: dossier.as_of, scan_version: MOMENTUM_SCAN_VERSION }
    : { source: "daily_bars (Alpaca)", feed: FEED, scan_version: MOMENTUM_SCAN_VERSION };
  const drawer = howWeKnow({ scan_id: "b2.momentum_entry", ticker, flag: false, evidence_level: "E0", provenance });

  return (
    <main className="ev-page">
      <p className="ev-meta"><Link href="/scans">Scan encyclopedia</Link> · momentum-entry dossier</p>
      <h1>{ticker} momentum dossier</h1>
      <EvidenceBadge level="E0" />
      <p className="ev-note">
        Computed from stored daily closes. This method has not been measured against outcomes (E0), so it describes
        the chart and predicts nothing. It is not investment advice.
      </p>
      {dossier.status === "missing" ? (
        <section><h2>Not enough data</h2><p>{dossier.reason}. Nothing is shown rather than a guess.</p></section>
      ) : (
        <section>
          <h2>Findings as of {dossier.as_of}</h2>
          {ageDays !== null && ageDays > STALE_AFTER_DAYS && (
            <p className="ev-note">Stale: the latest stored bar is {ageDays} days old.</p>
          )}
          <dl className="ev-kv">
            <dt>Close vs 200-day average</dt><dd>{dossier.findings.pct_above_sma200}%</dd>
            <dt>50-day above 200-day</dt><dd>{dossier.findings.sma50_above_sma200 ? "yes" : "no"}</dd>
            <dt>20-day return</dt><dd>{dossier.findings.return_20d_pct}%</dd>
            <dt>Bars used</dt><dd>{dossier.bars_used}</dd>
          </dl>
        </section>
      )}
      <details>
        <summary>How do we know?</summary>
        <dl className="ev-kv">
          <dt>Source</dt><dd>{drawer.source}</dd>
          <dt>Feed</dt><dd>{drawer.feed}</dd>
          <dt>As of</dt><dd>{drawer.as_of}</dd>
          <dt>Method version</dt><dd>{drawer.scan_version}</dd>
          <dt>Evidence level</dt><dd>{drawer.evidence_level}</dd>
        </dl>
      </details>
      <ProvenanceFooter provenance={provenance} />
    </main>
  );
}
