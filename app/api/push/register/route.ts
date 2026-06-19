import { auth } from "@clerk/nextjs/server";
import { clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const platform = typeof body.platform === "string" ? body.platform : "unknown";

  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  // Store push token in Clerk metadata — keeps it device-associated without a separate DB.
  const clerk = await clerkClient();
  await clerk.users.updateUserMetadata(userId, {
    privateMetadata: { push_token: token, push_platform: platform },
  });

  return NextResponse.json({ registered: true });
}
