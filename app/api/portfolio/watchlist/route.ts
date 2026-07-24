import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import type { WatchlistItem } from "@/lib/portfolio";
import { getWatchlist, addToWatchlist } from "@/lib/watchlist-store";
import { enqueueSignalRefresh } from "@/lib/signal-queue";
import { normalizeTicker } from "@/lib/shared/signal-lookup";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  try {
    const list = await getWatchlist(userId);
    return NextResponse.json(list);
  } catch (err) {
    console.error("Watchlist read failed", err);
    return NextResponse.json({ error: "watchlist unavailable" }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const ticker = normalizeTicker(body.ticker);
  if (!ticker) return NextResponse.json({ error: "valid ticker required" }, { status: 400 });

  try {
    const result = await addToWatchlist(userId, ticker);
    if (result === "exists") {
      return NextResponse.json({ error: "already in watchlist" }, { status: 409 });
    }
    // Best-effort — a fresh watchlist add should get a signal computed for it
    // without the user having to wait on this request (see lib/signal-queue.ts).
    await enqueueSignalRefresh(ticker, userId);
    return NextResponse.json(result satisfies WatchlistItem, { status: 201 });
  } catch (err) {
    console.error("Watchlist add failed", err);
    return NextResponse.json({ error: "watchlist unavailable" }, { status: 503 });
  }
}
