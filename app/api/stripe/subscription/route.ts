import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { parseSubscriptionMetadataWithAdmin } from "@/lib/subscription-admin";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();
  const state = parseSubscriptionMetadataWithAdmin(user?.publicMetadata, user);

  return NextResponse.json(state);
}
