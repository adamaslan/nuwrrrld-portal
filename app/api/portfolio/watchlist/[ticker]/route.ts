import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { store } from "../route";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const { ticker } = await params;
  const upper = ticker.toUpperCase();
  const list = store.get(userId) ?? [];
  store.set(userId, list.filter(i => i.ticker !== upper));
  return NextResponse.json({ removed: upper });
}
