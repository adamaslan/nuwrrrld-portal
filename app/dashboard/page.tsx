import { getStoredHoldFold } from "./holdfold/stored-signals";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import { parseSubscriptionMetadataWithAdmin } from "@/lib/subscription-admin";
import { isNulogdashAdmin } from "@/lib/nulogdash";
import { DashboardCockpit } from "./DashboardCockpit";
import { HealthBanner } from "./HealthBanner";
import type { IndexChip, MoverChip } from "./DashboardCockpit";
import { flagLive } from "@/lib/flags";
import "./dashboard.css";

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
  const mcpUrl = process.env.MCP_BACKEND_URL;
  if (!mcpUrl) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${mcpUrl}/market-overview?sections=brief`, { signal: ctrl.signal, next: { revalidate: 900 } });
    if (!res.ok) return null;
    return await res.json() as MarketOverview;
  } catch { return null; } finally { clearTimeout(t); }
}

async function fetchTopMovers(): Promise<MoverChip[]> {
  const { verdicts } = await getStoredHoldFold();
  return verdicts.slice(0, 4).map(v => ({ ticker: v.ticker, verdict: v.verdict,
    confidenceLabel: v.confidenceLabel, href: `/dashboard/holdfold/${encodeURIComponent(v.ticker)}` }));
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
  const { status, tier } = parseSubscriptionMetadataWithAdmin(user?.publicMetadata, user);
  const isPro = tier === "pro";
  const isAdmin = isNulogdashAdmin(user);

  const params = await searchParams;
  const checkoutSuccess = params.checkout === "success";

  // Top movers are hidden during the dark launch (holdfold data is stale), so skip the read.
  const [market, movers] = await Promise.all([
    fetchMarketOverview(),
    flagLive("holdfold_top_movers") ? fetchTopMovers() : Promise.resolve([] as MoverChip[]),
  ]);

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
          <Link href="/dashboard/followed-tickers">Followed</Link>
          <Link href="/dashboard/council/portfolios">Paper</Link>
          <Link href="/dashboard/share">Share</Link>
          <Link href="/dashboard/billing">Billing</Link>
          <Link href="/dashboard/beta">Founders</Link>
          {isAdmin && <Link href="/dashboard/nulogdash">nulogdash</Link>}
          <UserButton />
        </div>
      </nav>

      <main>
        <HealthBanner />
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

          <Link href="/dashboard/followed-tickers" className="tool tool--link">
            <div className="tool-head">
              <h2>Followed Tickers</h2>
              {isPro ? <span className="pill live">Live</span> : <span className="pill soon">Pro</span>}
            </div>
            <p>The app&apos;s 10 strongest bull and bear calls each month, frozen and scored against real prices across seven horizons — with an LLM grading the reasoning.</p>
            <span className="tool-cta">See the track record →</span>
          </Link>

          <Link href="/dashboard/council/portfolios" className="tool tool--link">
            <div className="tool-head">
              <h2>Paper Portfolios</h2>
              {isPro ? <span className="pill live">Live</span> : <span className="pill soon">Pro</span>}
            </div>
            <p>Eight simulated $10,000 accounts — one per AI council seat plus two baselines — trading the same rules, ranked by return, Sharpe and drawdown.</p>
            <span className="tool-cta">See the leaderboard →</span>
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
            <strong>Save 33%</strong> — switch to annual billing and pay $6.67/mo instead of $9.99/mo.{" "}
            <Link href="/dashboard/upgrade" className="upgrade-banner-link">Switch to annual →</Link>
          </div>
        )}
      </main>
    </div>
  );
}
