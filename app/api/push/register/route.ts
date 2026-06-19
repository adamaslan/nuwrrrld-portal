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

  // Store push tokens as an array keyed by token so multiple devices are supported.
  // Replace a matching existing entry or append — keeps the list bounded.
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const existing = (user.privateMetadata?.push_tokens as Array<{ token: string; platform: string }>) ?? [];
  const deduped = existing.filter(t => t.token !== token);
  const push_tokens = [...deduped, { token, platform }].slice(-10); // cap at 10 devices

  await clerk.users.updateUserMetadata(userId, {
    privateMetadata: { push_tokens },
  });

  return NextResponse.json({ registered: true });
}
