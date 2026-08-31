/**
 * GET /api/followed-tickers — the dashboard view-model for the followed-tickers
 * benchmark (docs/tickers-followed.md follow-up item 9).
 *
 * Read-only. Assembles the cohort cards + horizon scoreboard + judge scorecard
 * from `getViewData()` into the pure `FollowedTickersViewVM` shape that both the
 * portal page and a future gcp3-mobile screen render.
 *
 * Auth: a Clerk session, or the server-to-server `PORTAL_PUSH_SECRET` bearer
 * (same dual gate as /api/signals/top) so a mobile BFF / precompute job can
 * read it without a user context. Entitlement (`pro_signals`) is enforced for
 * user sessions only — an internal caller is already trusted.
 */
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { getViewData } from "@/lib/followed-tickers-db";
import { buildFollowedTickersView } from "@/lib/shared/followed-tickers-view";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { currentUser } from "@clerk/nextjs/server";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  const secret = process.env.PORTAL_PUSH_SECRET;
  const isInternal = bearerTokenMatches(req.headers.get("authorization"), secret);

  if (!userId && !isInternal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  if (userId && !isInternal) {
    const user = await currentUser();
    const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
    if (!hasEntitlement("pro_signals", tierFromStatus(status))) {
      return NextResponse.json({ error: "upgrade_required", feature: "pro_signals" }, { status: 403 });
    }
  }

  const raw = await getViewData();
  const view = buildFollowedTickersView({
    picks: raw.picks,
    observationsByPick: raw.observationsByPick,
    scores: raw.scores,
  });

  return NextResponse.json(view, {
    headers: {
      // The tracking run updates this once per trading day; a short public
      // cache is safe and keeps the dashboard snappy.
      "Cache-Control": "private, max-age=120, stale-while-revalidate=600",
    },
  });
}
