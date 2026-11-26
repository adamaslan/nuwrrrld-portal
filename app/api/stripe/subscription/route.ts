import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { parseSubscriptionWithPendingBeta } from "@/lib/subscription-admin-server";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();
  const state = await parseSubscriptionWithPendingBeta(user?.publicMetadata, user);

  return NextResponse.json(state);
}
