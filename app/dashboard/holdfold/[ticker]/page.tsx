import { getTickerVerdict } from "../stored-signals";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { resolveTier } from "@/lib/subscription-admin";
import type { HoldFoldVerdict } from "@/app/api/holdfold/route";
import { TrackRecordBadge } from "@/components/TrackRecordBadge";
import DisclaimerModal from "@/components/DisclaimerModal";
import DisclaimerFooter from "@/components/DisclaimerFooter";
import { AnalyzeLivePanel } from "./AnalyzeLivePanel";
import "../holdfold.css";

class BackendError extends Error {}

async function fetchVerdict(ticker: string): Promise<HoldFoldVerdict | null> {
  return getTickerVerdict(ticker);
}

export async function generateMetadata(
  { params }: { params: Promise<{ ticker: string }> }
): Promise<Metadata> {
  const { ticker } = await params;
  return { title: `${ticker.toUpperCase()} · Hold/Fold · NuWrrrld Financial` };
}

function fmt(n: number | null) { return n == null ? "—" : n.toFixed(2); }

function StrengthBadge({ strength }: { strength: string }) {
  const s = strength.toUpperCase();
  const cls = s === "BULLISH" ? "hf-sig-badge hf-sig-badge--bull"
    : s === "BEARISH" ? "hf-sig-badge hf-sig-badge--bear"
    : "hf-sig-badge hf-sig-badge--neutral";
  return <span className={cls}>{strength}</span>;
}

export default async function TickerDetailPage(
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const { userId } = await auth();
  if (!userId) {
    const returnUrl = `/dashboard/holdfold/${encodeURIComponent(ticker)}`;
    redirect(`/sign-in?${new URLSearchParams({ redirect_url: returnUrl }).toString()}`);
  }

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = resolveTier(status, user);

  if (!hasEntitlement("nu_ai", tier)) {
    redirect("/pricing?source=holdfold");
  }

  let v: HoldFoldVerdict | null;
  try {
    v = await fetchVerdict(ticker);
  } catch (err) {
    if (err instanceof BackendError) {
      // Backend unavailable — don't 404, surface a generic error
      throw err;
    }
    throw err;
  }
  if (!v) notFound();

  const verdictCls = v.verdict === "HOLD EM" ? "hf-verdict--hold" : v.verdict === "FOLD EM" ? "hf-verdict--fold" : "hf-verdict--neutral";

  return (
    <main className="hf-page">
      <div className="hf-header">
        <Link href="/dashboard/holdfold" className="hf-back">← Hold / Fold</Link>
      </div>

      <div className="hf-detail hf-detail--standalone">
        <div className="hf-detail-header">
          <div className="hf-detail-title">
            <span className="hf-detail-ticker">{v.ticker}</span>
            <span className={`hf-verdict-badge ${verdictCls}`}>{v.verdict}</span>
          </div>
          <p className="hf-detail-industry">{v.industry}</p>
        </div>

        <div className="hf-detail-conf">
          <span className="hf-conf-num">{Number.isFinite(v.confidence) ? v.confidence : "—"}</span>
          <span className="hf-conf-pct">{Number.isFinite(v.confidence) ? "%" : ""}</span>
          <span className="hf-conf-label">confidence · {v.bias}</span>
        </div>

        <div className="hf-ind-grid">
          <div className="hf-ind-cell"><span className="hf-ind-label">RSI</span><span className="hf-ind-val">{fmt(v.rsi)}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">MACD</span><span className="hf-ind-val">{fmt(v.macd)}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">ADX</span><span className="hf-ind-val">{fmt(v.adx)}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">PRICE</span><span className="hf-ind-val">{v.price > 0 ? `$${v.price.toFixed(2)}` : "—"}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">52W HIGH</span><span className="hf-ind-val">{v.high52w > 0 ? `$${v.high52w.toFixed(2)}` : "—"}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">52W LOW</span><span className="hf-ind-val">{v.low52w > 0 ? `$${v.low52w.toFixed(2)}` : "—"}</span></div>
        </div>

        {Object.keys(v.returns).length > 0 && (
          <div className="hf-returns">
            <p className="hf-section-label">RETURNS</p>
            <div className="hf-ind-grid">
              {(["1d", "1w", "1m", "3m", "1y"] as const).filter(k => v.returns[k] != null).map(k => (
                <div key={k} className="hf-ind-cell">
                  <span className="hf-ind-label">{k.toUpperCase()}</span>
                  <span className={`hf-ind-val ${v.returns[k] >= 0 ? "hf-ret--up" : "hf-ret--down"}`}>
                    {v.returns[k] >= 0 ? "+" : ""}{v.returns[k].toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {v.signals.length > 0 && (
          <div className="hf-sigs">
            <p className="hf-section-label">TOP SIGNALS</p>
            {v.signals.slice(0, 6).map((sig, i) => (
              <div key={i} className="hf-sig-row">
                <StrengthBadge strength={sig.strength} />
                <span className="hf-sig-text">{sig.signal}</span>
                {sig.detail && <span className="hf-sig-detail">{sig.detail}</span>}
              </div>
            ))}
          </div>
        )}

        {v.aiOutlook && (
          <div className="hf-outlook">
            <p className="hf-section-label">AI OUTLOOK</p>
            <p className="hf-outlook-text">{v.aiOutlook}</p>
          </div>
        )}

        <div className="hf-backtest-link">
          <p className="hf-section-label">TRACK RECORD</p>
          <TrackRecordBadge symbol={v.ticker} strength={v.confidenceLabel} />
        </div>

        <AnalyzeLivePanel ticker={v.ticker} />

        <div className="hf-detail-footer">
          <Link href="/dashboard/holdfold" className="hf-back" style={{ margin: 0 }}>
            ← Back to all verdicts
          </Link>
          <p className="hf-updated" style={{ margin: 0 }}>
            <span className="hf-updated-dot" />
            {new Date(v.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
          </p>
        </div>
      </div>

      <DisclaimerModal surface="analyze" />
      <DisclaimerFooter surface="analyze" />
    </main>
  );
}
