import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { getOrFetchDigest } from "@/lib/digest-cache";
import { SignalsClient } from "./SignalsClient";
import "./signals.css";

export const metadata: Metadata = {
  title: "Signal Digest · NuWrrrld Financial",
};

export default async function SignalsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/signals");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("signals_digest", tier)) {
    redirect("/pricing?source=signals");
  }

  // Shared cache/fallback chain with /api/signals/digest (pillar 6: graceful
  // degradation, signal-multiplication-analysis.md) — see lib/digest-cache.ts.
  const digest = await getOrFetchDigest(userId);

  return (
    <main className="signals-page">
      <div className="signals-header">
        <Link href="/dashboard" className="signals-back">← Dashboard</Link>
        <h1>Signal Digest</h1>
        {digest && <p className="signals-period">{digest.periodLabel}</p>}
      </div>

      {digest?.degraded && (
        <p className="signal-stale-badge">
          ⚠ Live signals are unavailable right now — showing the last cached digest.
        </p>
      )}

      {!digest && (
        <div className="signals-empty">
          <p>Signals are refreshing. Check back shortly — data is updated throughout the trading day.</p>
          <Link href="/dashboard" className="signals-cta">Go to dashboard</Link>
        </div>
      )}

      {digest && <SignalsClient signals={digest.signals} />}

      <p className="signals-disclaimer">
        Signals are informational only and not personalised financial advice. Past signals do not guarantee future results.
      </p>
    </main>
  );
}
