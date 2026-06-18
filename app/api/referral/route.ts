/**
 * Referral API — generates and validates referral codes.
 * Referral codes are stored in Clerk publicMetadata so they survive across devices.
 * Rewards: both referrer and referred get one free month (TRIAL_DAYS extension).
 */
import { auth, currentUser } from "@clerk/nextjs/server";
import { clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

function generateCode(userId: string): string {
  // Short, memorable code: first 6 chars of userId + 4 random alphanum chars.
  const base = userId.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${rand}`;
}

/** GET /api/referral — get or create the current user's referral code. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const existing = user?.publicMetadata?.referral_code as string | undefined;
  if (existing) return NextResponse.json({ code: existing, referralsCompleted: user?.publicMetadata?.referrals_completed ?? 0 });

  // Generate and store a new code.
  const code = generateCode(userId);
  const clerk = await clerkClient();
  await clerk.users.updateUserMetadata(userId, {
    publicMetadata: { referral_code: code, referrals_completed: 0 },
  });

  return NextResponse.json({ code, referralsCompleted: 0 });
}

/** POST /api/referral — redeem a referral code. Body: { code: string } */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const code = typeof body.code === 'string' ? body.code.toUpperCase().trim() : '';
  if (!code) return NextResponse.json({ error: "code required" }, { status: 400 });

  // Find the referrer by their referral_code in publicMetadata.
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({ limit: 100 });
  const referrer = users.find(u => (u.publicMetadata?.referral_code as string | undefined) === code);

  if (!referrer) return NextResponse.json({ error: "invalid code" }, { status: 404 });
  if (referrer.id === userId) return NextResponse.json({ error: "cannot use own code" }, { status: 400 });

  const alreadyRedeemed = currentUser().then(u => u?.publicMetadata?.referral_redeemed as boolean | undefined);
  if (await alreadyRedeemed) return NextResponse.json({ error: "already redeemed" }, { status: 409 });

  // Mark referrer's count and mark this user as referred.
  const prevCount = (referrer.publicMetadata?.referrals_completed as number) ?? 0;
  await Promise.all([
    clerk.users.updateUserMetadata(referrer.id, {
      publicMetadata: { referrals_completed: prevCount + 1 },
    }),
    clerk.users.updateUserMetadata(userId, {
      publicMetadata: { referral_redeemed: true, referred_by: referrer.id },
    }),
  ]);

  // Reward is a free month — handled via Stripe coupon in production.
  // For now we set a metadata flag that the billing system reads.
  return NextResponse.json({ redeemed: true, message: "You and your referrer each get a free month!" });
}
