import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { parseSubscriptionMetadata } from "@/lib/subscription";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();
  const state = parseSubscriptionMetadata(user?.publicMetadata);

  return NextResponse.json(state);
}
