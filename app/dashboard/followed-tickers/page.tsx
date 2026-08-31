import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { getViewData } from "@/lib/followed-tickers-db";
import { buildFollowedTickersView } from "@/lib/shared/followed-tickers-view";
import { FollowedTickersClient } from "./FollowedTickersClient";
import "./followed-tickers.css";

export const metadata: Metadata = {
  title: "Followed Tickers · NuWrrrld Financial",
  description:
    "The app's own strongest monthly calls, frozen and scored against realized prices across seven horizons — plus an LLM judge grading the reasoning.",
};

export default async function FollowedTickersPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/followed-tickers");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("pro_signals", tier)) {
    redirect("/pricing?source=followed-tickers");
  }

  // Server-render the first paint from the same pure builder the API uses, so
  // the page is useful with JS off and the client fetch is only a refresh.
  const raw = await getViewData();
  const initial = buildFollowedTickersView({
    picks: raw.picks,
    observationsByPick: raw.observationsByPick,
    scores: raw.scores,
  });

  return (
    <main className="ft-page">
      <header className="ft-header">
        <Link href="/dashboard" className="ft-back">← Dashboard</Link>
        <h1>Followed Tickers</h1>
        <p className="ft-sub">
          A frozen monthly cohort of the app&apos;s 10 most bullish and 10 most bearish
          calls, scored against realized prices across seven horizons — and graded for
          reasoning quality by an LLM judge that never sees the outcome.
        </p>
      </header>

      <FollowedTickersClient initial={initial} />

      <footer className="ft-disclaimer">
        This is a published track record, not advice. Hit-rates under{" "}
        {initial.minResolvedForRate} resolved picks are shown as{" "}
        <code>n&lt;{initial.minResolvedForRate}</code> rather than a percentage. Past
        accuracy does not guarantee future results.
      </footer>
    </main>
  );
}
