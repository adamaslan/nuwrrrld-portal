export const runtime = 'edge';
import { auth } from "@clerk/nextjs/server";
import { clerkClient } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { advanceStreak, type StreakState } from "@/lib/retention";

// Factory avoids stale timestamp from module-load-time evaluation.
function defaultStreak(): StreakState {
  return { currentStreak: 0, longestStreak: 0, lastActiveDate: "", updatedAt: new Date().toISOString() };
}

/** GET — return current streak. POST — record today's activity and advance streak. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const streak = (user.privateMetadata?.streak as StreakState | undefined) ?? defaultStreak();
  return NextResponse.json(streak);
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const current = (user.privateMetadata?.streak as StreakState | undefined) ?? defaultStreak();
  const updated = advanceStreak(current);

  // Only write if state changed (avoids unnecessary Clerk API calls).
  if (updated.updatedAt !== current.updatedAt) {
    await clerk.users.updateUserMetadata(userId, {
      privateMetadata: { streak: updated },
    });
  }

  return NextResponse.json(updated);
}
