import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

// Import the same store from the parent route.
// In production both routes would query the same database.
const store = new Map<string, { ticker: string; addedAt: string }[]>();

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { ticker } = await params;
  const list = store.get(userId) ?? [];
  const updated = list.filter(i => i.ticker !== ticker.toUpperCase());
  store.set(userId, updated);
  return NextResponse.json({ removed: ticker.toUpperCase() });
}
