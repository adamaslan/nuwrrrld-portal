import { getStoredHoldFold } from "./stored-signals";
import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { resolveTier } from "@/lib/subscription-admin";
import { HoldFoldClient } from "./HoldFoldClient";
import type { HoldFoldPayload } from "@/app/api/holdfold/route";
import "./holdfold.css";

export const metadata: Metadata = {
  title: "Hold/Fold · NuWrrrld Financial",
};

async function fetchHoldFoldData(): Promise<HoldFoldPayload | null> {
  return getStoredHoldFold();
}

function formatUpdated(iso: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "Unavailable";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

export default async function HoldFoldPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/holdfold");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = resolveTier(status, user);

  if (!hasEntitlement("nu_ai", tier)) {
    redirect("/pricing?source=holdfold");
  }

  const data = await fetchHoldFoldData();

  return (
    <main className="hf-page">
      <div className="hf-header">
        <Link href="/dashboard" className="hf-back">← Dashboard</Link>
        <div className="hf-title-row">
          <div>
            <h1>Hold / Fold</h1>
            <p className="hf-subtitle">Tactical trade verdicts with bias, risk, and indicator context.</p>
          </div>
          {data && (
            <div className="hf-meta">
              <div className="hf-counts">
                <span className="hf-count hf-count--hold">{data.holdCount} HOLD EM</span>
                <span className="hf-count hf-count--fold">{data.foldCount} FOLD EM</span>
                <span className="hf-count hf-count--neutral">{data.neutralCount} NEUTRAL</span>
              </div>
              <p className="hf-updated">
                <span className="hf-updated-dot" />
                Updated {formatUpdated(data.updatedAt)}
              </p>
            </div>
          )}
        </div>
      </div>

      {!data ? (
        <div className="hf-empty">
          <p>Signals are refreshing — check back shortly.</p>
          <Link href="/dashboard" className="hf-cta">← Back to Dashboard</Link>
        </div>
      ) : (
        <HoldFoldClient data={data} />
      )}
    </main>
  );
}
