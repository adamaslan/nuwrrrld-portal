import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import { tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import "./dashboard.css";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await currentUser();
  const firstName = user?.firstName ?? "investor";
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);
  const isPro = tier === "pro";

  const params = await searchParams;
  const checkoutSuccess = params.checkout === "success";

  const hour = new Date().getUTCHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <div className="nwf-dash">
      <nav className="topbar" aria-label="Dashboard navigation">
        <Link className="brand" href="/dashboard">
          <span className="brand-mark" aria-hidden="true">NWF</span>
          <span>NuWrrrld Financial</span>
        </Link>
        <div className="topnav">
          <Link href="/dashboard/signals">Signals</Link>
          <Link href="/dashboard/nuai">Nu AI</Link>
          <Link href="/dashboard/share">Share</Link>
          <Link href="/dashboard/billing">Billing</Link>
          <Link href="/dashboard/beta">Founders</Link>
          <UserButton />
        </div>
      </nav>

      <main>
        {checkoutSuccess && (
          <div className="checkout-notice success">
            ✓ Subscription started! Your 7-day trial begins now. See you at billing for details.
          </div>
        )}
        <div className="greeting">
          <h1>{greeting}, {firstName}.</h1>
          <span className="greeting-sub">
            {isPro ? "Pro · all features unlocked" : "Free plan · "}
            {!isPro && <Link href="/pricing" className="upgrade-link">upgrade to Pro →</Link>}
          </span>
        </div>

        <div className="tool-grid">
          <Link href="/dashboard/signals" className="tool tool--link">
            <div className="tool-head">
              <h2>Signal Digest</h2>
              {isPro
                ? <span className="pill live">Live</span>
                : <span className="pill soon">Pro</span>}
            </div>
            <p>Daily AI signals with plain-language explanations — which indicators fired, why, and what timeframe.</p>
            <span className="tool-cta">View today&apos;s signals →</span>
          </Link>

          <Link href="/dashboard/nuai" className="tool tool--link">
            <div className="tool-head">
              <h2>Nu AI</h2>
              {isPro
                ? <span className="pill live">Live</span>
                : <span className="pill soon">Pro</span>}
            </div>
            <p>Ask anything about your portfolio, signals, or market concepts. Answers grounded in your actual holdings.</p>
            <span className="tool-cta">Ask Nu AI →</span>
          </Link>

          <Link href="/dashboard/signals" className="tool tool--link">
            <div className="tool-head">
              <h2>Portfolio Health</h2>
              {isPro
                ? <span className="pill live">Live</span>
                : <span className="pill soon">Pro</span>}
            </div>
            <p>A health score graded A–F across risk, diversification, and momentum — with optimizer suggestions.</p>
            <span className="tool-cta">Check your score →</span>
          </Link>

          <Link href="/dashboard/share" className="tool tool--link">
            <div className="tool-head">
              <h2>Share &amp; Earn</h2>
              <span className="pill live">Live</span>
            </div>
            <p>Refer a friend and you both get a free month. Share your personal referral link in one tap.</p>
            <span className="tool-cta">Get your link →</span>
          </Link>
        </div>

        {!isPro && (
          <div className="upgrade-banner">
            <strong>Unlock all features</strong> — signal digest, Nu AI, and portfolio intelligence.{" "}
            <Link href="/pricing" className="upgrade-banner-link">Start 7-day free trial →</Link>
          </div>
        )}
      </main>
    </div>
  );
}
