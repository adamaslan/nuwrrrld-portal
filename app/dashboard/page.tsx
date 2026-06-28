import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import { tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { DashboardCockpit } from "./DashboardCockpit";
import type { IndexChip, MoverChip } from "./DashboardCockpit";
import "./dashboard.css";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

interface IndexEntry {
  symbol?: string;
  price?: number;
  change_pct?: number;
}

interface MarketOverview {
  brief?: {
    summary?: string;
    market_tone?: string;
    indices?: Record<string, IndexEntry>;
  };
}

async function fetchMarketOverview(): Promise<MarketOverview | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/market-overview`, { signal: ctrl.signal, next: { revalidate: 900 } });
    if (!res.ok) return null;
    return await res.json() as MarketOverview;
  } catch { return null; } finally { clearTimeout(t); }
}

async function fetchTopMovers(): Promise<MoverChip[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7_000);
  try {
    const res = await fetch(`${MCP_URL}/signals`, { signal: ctrl.signal, next: { revalidate: 900 } });
    if (!res.ok) return [];
    const raw = await res.json() as Record<string, unknown>;
    if (!raw?.symbols || typeof raw.symbols !== "object" || Array.isArray(raw.symbols)) return [];

    const symbols = raw.symbols as Record<string, Record<string, unknown>>;
    const verdicts = Object.entries(symbols).map(([key, s]) => {
      const ticker = String(s.symbol ?? key).trim().toUpperCase();
      const action = String(s.ai_action ?? "").toUpperCase();
      const confLabel = String(s.ai_confidence ?? "LOW").toUpperCase();
      const verdict = action === "BUY" ? "HOLD EM" : action === "SELL" ? "FOLD EM" : "NEUTRAL";
      const confNum = confLabel === "HIGH" ? 80 : confLabel === "MEDIUM" ? 55 : 30;
      return { ticker, verdict, confidenceLabel: confLabel, confidence: confNum };
    });

    // Top 3: highest-confidence HOLD EM first, then FOLD EM
    verdicts.sort((a, b) => {
      const order = { "HOLD EM": 0, "FOLD EM": 1, "NEUTRAL": 2 };
      const od = order[a.verdict as keyof typeof order] - order[b.verdict as keyof typeof order];
      return od !== 0 ? od : b.confidence - a.confidence;
    });

    return verdicts.slice(0, 4).map(v => ({
      ticker: v.ticker,
      verdict: v.verdict,
      confidenceLabel: v.confidenceLabel,
      href: `/dashboard/holdfold/${v.ticker}`,
    }));
  } catch { return []; } finally { clearTimeout(t); }
}

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

  const [market, movers] = await Promise.all([fetchMarketOverview(), fetchTopMovers()]);

  const indices: IndexChip[] = market?.brief?.indices
    ? Object.entries(market.brief.indices).slice(0, 4).map(([name, idx]) => ({
        name,
        symbol: idx.symbol ?? name,
        price: idx.price ?? null,
        changePct: idx.change_pct ?? null,
        tone: market.brief?.market_tone,
      }))
    : [];

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
          <Link href="/dashboard/holdfold">Hold/Fold</Link>
          <Link href="/dashboard/nuai">Nu AI</Link>
          <Link href="/dashboard/portfolio">Portfolio</Link>
          <Link href="/dashboard/share">Share</Link>
          <Link href="/dashboard/billing">Billing</Link>
          <Link href="/dashboard/beta">Founders</Link>
          <UserButton />
        </div>
      </nav>

      <main>
        {checkoutSuccess && (
          <div className="checkout-notice success">
            ✓ Subscription started! Your 7-day trial begins now.{" "}
            <Link href="/dashboard/billing">Manage billing →</Link>
          </div>
        )}
        <div className="greeting">
          <h1>{greeting}, {firstName}.</h1>
          <span className="greeting-sub">
            {isPro ? "Pro · all features unlocked" : "Free plan · "}
            {!isPro && <Link href="/pricing" className="upgrade-link">upgrade to Pro →</Link>}
          </span>
        </div>

        <DashboardCockpit
          isPro={isPro}
          indices={indices}
          marketTone={market?.brief?.market_tone}
          movers={movers}
        />

        <div className="tool-grid">
          <Link href="/dashboard/signals" className="tool tool--link">
            <div className="tool-head">
              <h2>Signal Digest</h2>
              {isPro ? <span className="pill live">Live</span> : <span className="pill soon">Pro</span>}
            </div>
            <p>Daily AI signals with plain-language explanations — which indicators fired, why, and what timeframe.</p>
            <span className="tool-cta">View today&apos;s signals →</span>
          </Link>

          <Link href="/dashboard/nuai" className="tool tool--link">
            <div className="tool-head">
              <h2>Nu AI</h2>
              {isPro ? <span className="pill live">Live</span> : <span className="pill soon">Pro</span>}
            </div>
            <p>Ask anything about your portfolio, signals, or market concepts. Answers grounded in your actual holdings.</p>
            <span className="tool-cta">Ask Nu AI →</span>
          </Link>

          <Link href="/dashboard/holdfold" className="tool tool--link">
            <div className="tool-head">
              <h2>Hold / Fold</h2>
              {isPro ? <span className="pill live">Live</span> : <span className="pill soon">Pro</span>}
            </div>
            <p>Tactical trade verdicts with bias, risk, volatility regime, and the exact indicator readings behind them.</p>
            <span className="tool-cta">Get verdicts →</span>
          </Link>

          <Link href="/dashboard/share" className="tool tool--link">
            <div className="tool-head">
              <h2>Share &amp; Earn</h2>
              <span className="pill live">Live</span>
            </div>
            <p>Refer a friend and you both get a free month. Share your personal referral link in one tap.</p>
            <span className="tool-cta">Get your link →</span>
          </Link>

          <Link href="/dashboard/portfolio" className="tool tool--link">
            <div className="tool-head">
              <h2>Portfolio Intel</h2>
              {isPro ? <span className="pill live">Live</span> : <span className="pill soon">Pro</span>}
            </div>
            <p>Watchlist manager, sector rotation, and AI health check — grounded in real factor data.</p>
            <span className="tool-cta">Open portfolio →</span>
          </Link>
        </div>

        {!isPro && (
          <div className="upgrade-banner">
            <strong>Unlock all features</strong> — signal digest, Nu AI, and portfolio intelligence.{" "}
            <Link href="/pricing" className="upgrade-banner-link">Start 7-day free trial →</Link>
          </div>
        )}

        {isPro && status === "active" && (
          <div className="upgrade-banner upgrade-banner--annual">
            <strong>Save 34%</strong> — switch to annual billing and pay $6.58/mo instead of $9.99/mo.{" "}
            <Link href="/dashboard/upgrade" className="upgrade-banner-link">Switch to annual →</Link>
          </div>
        )}
      </main>
    </div>
  );
}
