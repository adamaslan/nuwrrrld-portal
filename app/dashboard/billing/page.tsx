import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ManageBillingButton } from "./ManageBillingButton";
import { tierFromStatus } from "@nwf/lib/subscription";
import type { SubscriptionStatus } from "@nwf/lib/subscription";
import "./billing.css";

export const metadata: Metadata = {
  title: "Billing · NuWrrrld Financial",
};

export default async function BillingPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const meta = user?.publicMetadata ?? {};

  const status = (meta.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);
  const trialEndSeconds = meta.trial_end as number | undefined;
  const periodEndSeconds = meta.current_period_end as number | undefined;
  const hasStripeCustomer = Boolean(meta.stripe_customer_id);

  const formatDate = (seconds: number) =>
    new Date(seconds * 1000).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

  return (
    <main className="billing-page">
      <div className="billing-header">
        <Link href="/dashboard" className="billing-back">← Dashboard</Link>
        <h1>Billing & subscription</h1>
      </div>

      <div className="billing-card">
        <div className="billing-row">
          <span className="billing-label">Plan</span>
          <span className={`billing-tier billing-tier--${tier}`}>
            {tier === "pro" ? "Pro" : "Free"}
          </span>
        </div>

        <div className="billing-row">
          <span className="billing-label">Status</span>
          <span className={`billing-status billing-status--${status}`}>
            {status.replace("_", " ")}
          </span>
        </div>

        {status === "trialing" && trialEndSeconds && (
          <div className="billing-row">
            <span className="billing-label">Trial ends</span>
            <span>{formatDate(trialEndSeconds)}</span>
          </div>
        )}

        {status === "active" && periodEndSeconds && (
          <div className="billing-row">
            <span className="billing-label">Next renewal</span>
            <span>{formatDate(periodEndSeconds)}</span>
          </div>
        )}

        <div className="billing-actions">
          {hasStripeCustomer && (status === "active" || status === "trialing" || status === "past_due") ? (
            <ManageBillingButton />
          ) : (
            <Link href="/pricing" className="billing-upgrade-btn">
              Upgrade to Pro
            </Link>
          )}
        </div>
      </div>

      <p className="billing-note">
        Billing is managed through Stripe. Cancel anytime from the billing portal.
        This is not financial advice.
      </p>
    </main>
  );
}
