import { auth, currentUser } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { flagLive } from "@/lib/flags";
import { isNulogdashReplayOwner } from "@/lib/nulogdash";
import { loadHistoricalReplay } from "@/lib/historical-replay-store";
import { HistoricalReplaySection } from "@/components/research/HistoricalReplaySection";
import "./replay.css";

export const metadata: Metadata = {
  title: "Historical replay (research) · NuWrrrld Financial",
  robots: { index: false, follow: false },
};

// Read per request; the artifact is a static file but access is per user.
export const dynamic = "force-dynamic";

/**
 * Owner-only while derived-data audience and rights are unresolved: the flag
 * must be live AND the viewer must be an replay-owner allowlisted, verified-primary-email
 * user (separate from the shared admin allowlist). Anyone else gets a
 * 404, so the page's existence is not disclosed to other signed-in users.
 */
export default async function HistoricalReplayPage() {
  if (!flagLive("historical_replay_research")) notFound();

  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/research/historical-replay");

  const user = await currentUser();
  if (!isNulogdashReplayOwner(user)) notFound();

  return <HistoricalReplaySection result={await loadHistoricalReplay()} />;
}
