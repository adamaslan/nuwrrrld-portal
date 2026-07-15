import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { removeFromWatchlist } from "@/lib/watchlist-store";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  try {
    await removeFromWatchlist(userId, upper);
    return NextResponse.json({ removed: upper });
  } catch (err) {
    console.error("Watchlist remove failed", err);
    return NextResponse.json({ error: "watchlist unavailable" }, { status: 503 });
  }
}
