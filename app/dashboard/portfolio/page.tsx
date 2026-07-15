import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { getWatchlist } from "@/lib/watchlist-store";
import { PortfolioClient } from "./PortfolioClient";
import "./portfolio.css";

export const metadata: Metadata = {
  title: "Portfolio · NuWrrrld Financial",
};

const MCP_URL = process.env.MCP_BACKEND_URL;

interface IndustryEntry {
  sector?: string;
  etf?: string;
  change_pct?: number;
  returns?: Record<string, number>;
  ai_score?: number;
  ai_action?: string;
}

async function fetchIndustryData() {
  if (!MCP_URL) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7_000);
  try {
    const res = await fetch(`${MCP_URL}/industry-intel`, {
      signal: ctrl.signal,
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = await res.json() as { date?: string; industries?: Record<string, IndustryEntry> };
    const industries = data.industries ?? {};
    const sorted = Object.entries(industries)
      .filter(([, e]) => e.change_pct != null)
      .sort(([, a], [, b]) => (b.change_pct ?? 0) - (a.change_pct ?? 0));
    const toEntry = ([name, e]: [string, IndustryEntry]) => ({
      name,
      changePct: e.change_pct ?? 0,
      returns: e.returns ?? {},
      aiScore: e.ai_score ?? null,
      aiAction: e.ai_action ?? null,
    });
    return {
      gainers: sorted.slice(0, 5).map(toEntry),
      losers: sorted.slice(-5).reverse().map(toEntry),
    };
  } catch { return null; } finally { clearTimeout(t); }
}

export default async function PortfolioPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/portfolio");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    redirect("/pricing?source=portfolio");
  }

  const [industryData, watchlist] = await Promise.all([
    fetchIndustryData(),
    getWatchlist(userId).catch((err) => {
      console.error("Watchlist read failed", err);
      return [];
    }),
  ]);

  return (
    <main className="port-page">
      <Link href="/dashboard" className="port-back">← Dashboard</Link>
      <div className="port-title-row">
        <div>
          <h1>Portfolio Intelligence</h1>
          <p className="port-subtitle">Watchlist manager · Sector rotation · AI health check</p>
        </div>
      </div>

      <PortfolioClient
        initialWatchlist={watchlist}
        gainers={industryData?.gainers ?? []}
        losers={industryData?.losers ?? []}
      />

      <p className="port-disclaimer">
        Portfolio analysis is informational only and is not personalised financial advice.
        All suggestions are educational and should not be acted upon without independent research.
      </p>
    </main>
  );
}
