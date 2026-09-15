import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { resolveTier } from "@/lib/subscription-admin";
import { listAccounts, getLatestRun, getNavSeries, type NavPoint } from "@/lib/paper-db";
import { PAPER_ACCOUNTS, type PaperAccount } from "@/lib/shared/paper-policy";
import { buildLeaderboardView, type AccountMetrics } from "@/lib/shared/paper-view";
import { PaperPortfoliosClient } from "./PaperPortfoliosClient";
import DisclaimerFooter from "@/components/DisclaimerFooter";
import "./paper-portfolios.css";

export const metadata: Metadata = {
  title: "Council Paper Portfolios · NuWrrrld Financial",
  description:
    "Eight simulated $10,000 paper-trading books — one per AI council seat, plus two baselines — tracked against realized prices four times a trading day.",
};

// Entitlement: no explicit call in the design doc (docs/council-paper-portfolios.md
// §6 lists the route but not its gate) — pro_signals is followed-tickers' own
// choice for a comparable "the app's own track record" surface, adopted here
// as the same default rather than left ambiguous. Flagged in
// docs/paper-portfolios-remaining-todo.md's Phase 7 section as a decision
// made, not silently assumed.
const REQUIRED_ENTITLEMENT = "pro_signals" as const;

export default async function PaperPortfoliosPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/council/portfolios");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = resolveTier(status, user);

  if (!hasEntitlement(REQUIRED_ENTITLEMENT, tier)) {
    redirect("/pricing?source=paper-portfolios");
  }

  const accounts = await listAccounts();
  const metricsByAccount = new Map<PaperAccount, AccountMetrics | null>();
  const latestNavByAccount = new Map<PaperAccount, NavPoint | null>();
  await Promise.all(
    PAPER_ACCOUNTS.map(async (account) => {
      const [run, [latestNav]] = await Promise.all([getLatestRun(account, "settle"), getNavSeries(account, 1)]);
      metricsByAccount.set(account, (run?.detail?.metrics as AccountMetrics | undefined) ?? null);
      latestNavByAccount.set(account, latestNav ?? null);
    }),
  );
  const initial = buildLeaderboardView(accounts, metricsByAccount, latestNavByAccount);

  return (
    <main className="pp-page">
      <header className="pp-header">
        <Link href="/dashboard" className="pp-back">← Dashboard</Link>
        <h1>Council Paper Portfolios</h1>
        <p className="pp-sub">
          Eight simulated $10,000 accounts — one per AI council seat (T1, T2, RISK, MACRO,
          QUANT, CHAIR), plus two baselines (equal-weight and buy-and-hold) — trading a fixed,
          pre-chosen watchlist four times a trading day. No real money, no broker, no order ever
          leaves the database.
        </p>
      </header>

      <PaperPortfoliosClient initial={initial} />

      <DisclaimerFooter surface="paper" />
    </main>
  );
}
