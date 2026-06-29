export const runtime = 'edge';
/**
 * Referral API — generates and validates referral codes.
 * Codes are stored in Clerk publicMetadata so they survive across devices.
 * Reward: referrer and referred each get a free month (metadata flag read by billing).
 */
import { auth, currentUser } from "@clerk/nextjs/server";
import { clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Unambiguous chars
const CODE_LENGTH = 10;

function generateCode(): string {
  // CSPRNG — no user-derived prefix so codes don't leak user ID shape.
  const buf = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** GET /api/referral — get or create the current user's referral code. */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const existing = user?.publicMetadata?.referral_code as string | undefined;
  if (existing) {
    return NextResponse.json({
      code: existing,
      referralsCompleted: user?.publicMetadata?.referrals_completed ?? 0,
    });
  }

  const code = generateCode();
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

  // Check if current user already redeemed before doing the lookup scan.
  const me = await currentUser();
  if (me?.publicMetadata?.referral_redeemed) {
    return NextResponse.json({ error: "already redeemed" }, { status: 409 });
  }

  // Lookup by referral code. For scale, store codes in a DB with an indexed query.
  // getUserList limit is a known constraint — acceptable at founding-user scale.
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({ limit: 500 });
  const referrer = users.find(
    u => (u.publicMetadata?.referral_code as string | undefined) === code
  );

  if (!referrer) return NextResponse.json({ error: "invalid code" }, { status: 404 });
  if (referrer.id === userId) return NextResponse.json({ error: "cannot use own code" }, { status: 400 });

  const prevCount = (referrer.publicMetadata?.referrals_completed as number) ?? 0;
  await Promise.all([
    clerk.users.updateUserMetadata(referrer.id, {
      publicMetadata: { referrals_completed: prevCount + 1 },
    }),
    clerk.users.updateUserMetadata(userId, {
      publicMetadata: { referral_redeemed: true, referred_by: referrer.id },
    }),
  ]);

  return NextResponse.json({ redeemed: true, message: "You and your referrer each get a free month!" });
}
