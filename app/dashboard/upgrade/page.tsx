import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { CheckoutButton } from "@/app/pricing/CheckoutButton";
import "./upgrade.css";

export const metadata: Metadata = { title: "Upgrade to Annual · Save 34%" };

export default async function UpgradePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/upgrade");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  // Only show this page to active monthly subscribers.
  if (tier !== "pro" || status !== "active") redirect("/pricing");

  return (
    <main className="upgrade-page">
      <Link href="/dashboard" className="upgrade-back">← Dashboard</Link>

      <div className="upgrade-hero">
        <span className="upgrade-badge">Save 34%</span>
        <h1>Switch to annual billing</h1>
        <p className="upgrade-sub">
          You&apos;re paying $9.99/mo. Switch to annual and pay just $6.58/mo —
          that&apos;s $79/yr vs $119.88/yr. Same everything, lower price.
        </p>
      </div>

      <div className="upgrade-comparison">
        <div className="upgrade-plan upgrade-plan--current">
          <p className="plan-label">Current</p>
          <p className="plan-price">$9.99<span>/mo</span></p>
          <p className="plan-total">$119.88/yr</p>
        </div>
        <div className="upgrade-arrow">→</div>
        <div className="upgrade-plan upgrade-plan--annual">
          <p className="plan-label">Annual</p>
          <p className="plan-price">$6.58<span>/mo</span></p>
          <p className="plan-total">$79/yr · save $40.88</p>
        </div>
      </div>

      <CheckoutButton plan="annual" label="Switch to annual — save 34%" />

      <p className="upgrade-note">
        Your monthly subscription will be cancelled and the annual plan starts immediately.
        Pro-rated credit applied. <Link href="/dashboard/billing">Manage billing</Link>
      </p>
      <p className="upgrade-disclaimer">Not financial advice.</p>
    </main>
  );
}
