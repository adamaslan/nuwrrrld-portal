import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { adaptLiveSignals, type DigestPayload } from "@/lib/digest";
import { SignalShareButton } from "@/components/SignalShareButton";
import "./signals.css";

export const metadata: Metadata = {
  title: "Signal Digest · NuWrrrld Financial",
};

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 8_000;

/** Fetch live signals from GCP3 backend — public endpoint, no auth header needed. */
async function fetchDigest(): Promise<DigestPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals`, { signal: controller.signal });
    if (!res.ok) return null;
    const raw = await res.json();
    return adaptLiveSignals(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function SignalsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/signals");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("signals_digest", tier)) {
    redirect("/pricing?source=signals");
  }

  const digest = await fetchDigest();

  return (
    <main className="signals-page">
      <div className="signals-header">
        <Link href="/dashboard" className="signals-back">← Dashboard</Link>
        <h1>Signal Digest</h1>
        {digest && <p className="signals-period">{digest.periodLabel}</p>}
      </div>

      {!digest && (
        <div className="signals-empty">
          <p>Signals are refreshing. Check back shortly — data is updated throughout the trading day.</p>
          <Link href="/dashboard" className="signals-cta">Go to dashboard</Link>
        </div>
      )}

      {digest && (
        <div className="signals-list">
          {digest.signals.map(sig => (
            <div key={sig.id} id={`signal-${sig.id}`} className="signal-card">
              <div className="signal-card-header">
                <div>
                  <span className="signal-ticker">{sig.ticker}</span>
                  <span className={`signal-direction signal-direction--${sig.direction}`}>
                    {sig.direction === "bullish" ? "↑" : sig.direction === "bearish" ? "↓" : "→"}{" "}
                    {sig.direction}
                  </span>
                </div>
                <SignalShareButton signal={sig} />
              </div>
              <p className="signal-meta">{sig.timeframe} · {sig.confidence} confidence</p>
              <p className="signal-title">{sig.title}</p>
              <details className="signal-why">
                <summary>Why this signal</summary>
                <p className="signal-explanation">{sig.explanation}</p>
                {sig.indicators.length > 0 && (
                  <div className="signal-indicators">
                    {sig.indicators.map(ind => (
                      <span key={ind} className="signal-chip">{ind}</span>
                    ))}
                  </div>
                )}
              </details>
            </div>
          ))}
        </div>
      )}

      <p className="signals-disclaimer">
        Signals are informational only and not personalised financial advice. Past signals do not guarantee future results.
      </p>
    </main>
  );
}
