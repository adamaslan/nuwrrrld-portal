import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import type { WatchlistItem } from "@/lib/portfolio";
import { store } from "@/lib/watchlist-store";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.json(store.get(userId) ?? []);
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const ticker = typeof body.ticker === 'string' ? body.ticker.toUpperCase().trim() : '';
  if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });

  const list = store.get(userId) ?? [];
  if (list.some(i => i.ticker === ticker)) {
    return NextResponse.json({ error: "already in watchlist" }, { status: 409 });
  }
  const item: WatchlistItem = { ticker, addedAt: new Date().toISOString() };
  store.set(userId, [...list, item]);
  return NextResponse.json(item, { status: 201 });
}
