import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { resolveTier } from "@/lib/subscription-admin";
import { loadArena } from "@/lib/paper-arena";
import type { ArenaVM } from "@/lib/shared/paper-arena-view";
import { PaperArenaClient } from "./PaperArenaClient";
import DisclaimerFooter from "@/components/DisclaimerFooter";
import "../paper-portfolios.css";
import "./arena.css";

export const metadata: Metadata = {
  title: "Paper Account Arena · NuWrrrld Financial",
  description: "All eight simulated paper accounts side by side: judged metrics, equity curves, and every trade with its reason.",
};

// Same gate as the leaderboard page this extends.
const REQUIRED_ENTITLEMENT = "pro_signals" as const;

export default async function PaperArenaPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/council/portfolios/arena");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = resolveTier(status, user);
  if (!hasEntitlement(REQUIRED_ENTITLEMENT, tier)) redirect("/pricing?source=paper-arena");

  let initial: ArenaVM | null = null;
  try {
    initial = await loadArena();
  } catch (err) {
    console.error("[paper-arena page] load failed", err);
  }

  return (
    <main className="pp-page pa-page">
      <header className="pp-header">
        <Link href="/dashboard/council/portfolios" className="pp-back">← Leaderboard</Link>
        <h1>Paper Account Arena</h1>
        <p className="pp-sub">
          Six AI-council accounts judged against two baselines (equal-weight and SPY buy-and-hold).
          Simulated $10,000 books, no real money. Compare the metrics, watch the curves diverge, and
          read the reason behind every trade.
        </p>
      </header>
      <PaperArenaClient initial={initial} />
      <DisclaimerFooter surface="paper" />
    </main>
  );
}
