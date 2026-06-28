import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { adaptLiveSignals } from "@/lib/digest";
import type { DigestPayload } from "@/lib/digest";
import { SignalsClient } from "./SignalsClient";
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

      {digest && <SignalsClient signals={digest.signals} />}

      <p className="signals-disclaimer">
        Signals are informational only and not personalised financial advice. Past signals do not guarantee future results.
      </p>
    </main>
  );
}
