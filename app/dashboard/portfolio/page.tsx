import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { resolveTier } from "@/lib/subscription-admin";
import { getWatchlist } from "@/lib/watchlist-store";
import { PortfolioClient } from "./PortfolioClient";
import "./portfolio.css";

export const metadata: Metadata = {
  title: "Portfolio · NuWrrrld Financial",
};

export default async function PortfolioPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/portfolio");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = resolveTier(status, user);

  if (!hasEntitlement("nu_ai", tier)) {
    redirect("/pricing?source=portfolio");
  }

  const watchlist = await getWatchlist(userId).catch((err) => {
    console.error("Watchlist read failed", err);
    return [];
  });

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
      />

      <p className="port-disclaimer">
        Portfolio analysis is informational only and is not personalised financial advice.
        All suggestions are educational and should not be acted upon without independent research.
      </p>
    </main>
  );
}
