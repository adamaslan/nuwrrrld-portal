import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import type { WatchlistItem } from "@/lib/portfolio";
import { getWatchlist, addToWatchlist } from "@/lib/watchlist-store";

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
  const ticker = typeof body.ticker === 'string' ? body.ticker.toUpperCase().trim() : '';
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  try {
    const result = await addToWatchlist(userId, ticker);
    if (result === "exists") {
      return NextResponse.json({ error: "already in watchlist" }, { status: 409 });
    }
    return NextResponse.json(result satisfies WatchlistItem, { status: 201 });
  } catch (err) {
    console.error("Watchlist add failed", err);
    return NextResponse.json({ error: "watchlist unavailable" }, { status: 503 });
  }
}
