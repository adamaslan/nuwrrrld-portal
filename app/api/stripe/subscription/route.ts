export const runtime = 'edge';
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { SubscriptionState } from "@/lib/subscription";
import { tierFromStatus } from "@/lib/subscription";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();
  const meta = user?.publicMetadata ?? {};

  const rawStatus = (meta.subscription_status as string) ?? 'free';
  const trialEndSeconds = meta.trial_end as number | undefined;
  const trialEnd = trialEndSeconds ? new Date(trialEndSeconds * 1000).toISOString() : undefined;

  const state: SubscriptionState = {
    status: rawStatus as SubscriptionState['status'],
    tier: tierFromStatus(rawStatus as SubscriptionState['status']),
    trialEnd,
    isLoading: false,
  };

  return NextResponse.json(state);
}
