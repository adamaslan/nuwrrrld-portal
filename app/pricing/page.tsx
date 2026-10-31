import type { Metadata } from "next";
import Link from "next/link";
import { CheckoutButton } from "./CheckoutButton";
import { PreLoginNav, PreLoginFooter } from "@/components/landing/PreLoginShell";
import "../landing.css";
import "./pricing.css";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Start free, no card required. Pro adds the daily signal digest, Nu AI assistant, and the morning briefing — with a 7-day free trial (card required).",
};

export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const params = await searchParams;

  // Pricing is viewable by anyone — signed-out visitors previously got
  // redirected to /sign-up?redirect_url=/pricing, which lands back on /pricing
  // after signing up, forming a redirect loop with no way to see plans first.
  // Auth is now only required at the checkout action itself; CheckoutButton
  // sends unauthenticated clicks to sign-in instead.
  const cancelled = params.checkout === "cancelled";

  return (
    <div className="nwf-landing">
      <PreLoginNav />

      <main className="pricing-page">
        <div className="pricing-hero">
          <h1>Pricing that starts free</h1>
          <p className="pricing-sub">
            Create a free account — no card required.
            Pro adds the daily digest, Nu AI, and the morning briefing, with a 7-day free trial (card required).
          </p>
          {cancelled && (
            <p className="pricing-notice">Checkout was cancelled — no charge was made.</p>
          )}
        </div>

        <div className="pricing-cards">
          {/* Free column lists only what a free account verifiably gets today
              (dashboard home with the market overview). FEATURE_TIER_MAP also
              marks signals + portfolio_score as free-tier, but no caller grants
              them to free users yet - see PR body before adding them here. */}
          <div className="pricing-card">
            <div className="plan-name">Free</div>
            <div className="plan-price">
              <span className="price-amount">$0</span>
            </div>
            <ul className="plan-features">
              <li>Market overview dashboard</li>
              <li>Public council verdict pages</li>
              <li>No card required</li>
            </ul>
            <Link href="/sign-up" className="checkout-btn checkout-btn--link">Create free account</Link>
          </div>

          {/* Monthly */}
          <div className="pricing-card pricing-card--featured">
            <div className="plan-badge">7-day free trial</div>
            <div className="plan-name">Pro — Monthly</div>
            <div className="plan-price">
              <span className="price-amount">$9.99</span>
              <span className="price-period">/mo</span>
            </div>
            <ul className="plan-features">
              <li>Everything in Free</li>
              <li>Daily signal digest</li>
              <li>Nu AI assistant</li>
              <li>Morning briefing</li>
            </ul>
            <CheckoutButton plan="monthly" label="Start 7-day free trial" />
          </div>

          {/* Annual */}
          <div className="pricing-card">
            <div className="plan-name">Pro — Annual</div>
            <div className="plan-price">
              <span className="price-amount">$79.99</span>
              <span className="price-period">/yr</span>
            </div>
            <ul className="plan-features">
              <li>Everything in Pro Monthly</li>
              <li>Save 33% vs monthly</li>
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

      <PreLoginFooter />
    </div>
  );
}
