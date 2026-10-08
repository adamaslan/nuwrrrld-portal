import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { removeFromWatchlist } from "@/lib/watchlist-store";
import { normalizeTicker } from "@/lib/shared/signal-policy";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { ticker } = await params;
  const upper = normalizeTicker(ticker);
  if (!upper) return NextResponse.json({ error: "valid ticker required" }, { status: 400 });
  try {
    await removeFromWatchlist(userId, upper);
    return NextResponse.json({ removed: upper });
  } catch (err) {
    console.error("Watchlist remove failed", err);
    return NextResponse.json({ error: "watchlist unavailable" }, { status: 503 });
  }
}
