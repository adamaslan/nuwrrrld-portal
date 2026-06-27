import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { callCouncilSeat, type CouncilSeat } from "@/lib/openrouter";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    return NextResponse.json({ error: "upgrade_required" }, { status: 403 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Council not configured" }, { status: 503 });

  const body = await req.json().catch(() => ({}));
  const { prompt, seat = "T1" } = body as { prompt?: string; seat?: CouncilSeat };

  if (!prompt?.trim()) {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }

  try {
    const result = await callCouncilSeat(seat as CouncilSeat, prompt, apiKey);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Council error", err);
    return NextResponse.json({ error: "Council unavailable" }, { status: 503 });
  }
}
