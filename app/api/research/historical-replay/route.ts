import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { flagLive } from "@/lib/flags";
import { isNulogdashReplayOwner } from "@/lib/nulogdash";
import { loadHistoricalReplay } from "@/lib/historical-replay-store";

/**
 * GET /api/research/historical-replay
 * Read-only view of the reconstructed (point-in-time replay) research artifact.
 * Owner-bound: the artifact is Adam-private research data, so the replay-owner
 * gate (NULOGDASH_REPLAY_OWNER_EMAILS, verified primary email, fails closed) is
 * required - any signed-in user is not enough, and neither is membership in the
 * shared NULOGDASH_ADMIN_EMAILS allowlist. 204 while the dark-launch flag is off
 * (nothing is read), 401 signed-out, 403 signed-in non-owner, otherwise the
 * loader result.
 * Always labelled research: not the live track record, not a prior, and not
 * wired to the old /api/backtest 2y proxy or the AI cache. The artifact bytes
 * come from a file, or from the dedicated single-row replay_artifact table when
 * REPLAY_ARTIFACT_SOURCE=db (see lib/historical-replay-store.ts); either way the
 * REPLAY_ARTIFACT_SHA256 pin is verified after the read.
 */
export async function GET() {
  if (!flagLive("historical_replay_research")) return new NextResponse(null, { status: 204 });

  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  if (!isNulogdashReplayOwner(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const result = await loadHistoricalReplay();
  return NextResponse.json(result, { headers: { "cache-control": "private, no-store" } });
}
