import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { CheckoutButton } from "./CheckoutButton";
import "./pricing.css";

export const metadata: Metadata = {
  title: "Pricing · NuWrrrld Financial",
  description: "Start your 7-day free trial. Signals, AI assistant, and portfolio intelligence.",
};

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { userId } = await auth();
  const params = await searchParams;

  // Redirect signed-out visitors to sign-up with pricing as the destination
  if (!userId) {
    redirect("/sign-up?redirect_url=/pricing");
  }

  const cancelled = params.checkout === "cancelled";

  return (
    <main className="pricing-page">
      <div className="pricing-hero">
        <h1>Start your 7-day free trial</h1>
        <p className="pricing-sub">
          Full access to signals, AI assistant, and portfolio intelligence.
          Cancel anytime.
        </p>
        {cancelled && (
          <p className="pricing-notice">Checkout was cancelled — no charge was made.</p>
        )}
      </div>

      <div className="pricing-cards">
        {/* Monthly */}
        <div className="pricing-card">
          <div className="plan-name">Monthly</div>
          <div className="plan-price">
            <span className="price-amount">$9.99</span>
            <span className="price-period">/mo</span>
          </div>
          <ul className="plan-features">
            <li>Daily signal digest</li>
            <li>Nu AI assistant</li>
            <li>Portfolio health score</li>
            <li>Optimizer suggestions</li>
            <li>Watchlist alerts</li>
            <li>Morning briefing</li>
          </ul>
          <CheckoutButton plan="monthly" label="Start 7-day free trial" />
        </div>

        {/* Annual */}
        <div className="pricing-card pricing-card--featured">
          <div className="plan-badge">Best value — save 34%</div>
          <div className="plan-name">Annual</div>
          <div className="plan-price">
            <span className="price-amount">$79</span>
            <span className="price-period">/yr</span>
          </div>
          <ul className="plan-features">
            <li>Everything in Monthly</li>
            <li>Priority signal delivery</li>
            <li>Extended AI context</li>
          </ul>
          <CheckoutButton plan="annual" label="Start 7-day free trial" />
        </div>
      </div>

      <p className="pricing-legal">
        By subscribing you agree to our{" "}
        <a href="/terms-of-service">Terms of Service</a> and{" "}
        <a href="/privacy-policy">Privacy Policy</a>.
        Payment is processed by Stripe. This is not financial advice.
      </p>
    </main>
  );
}
