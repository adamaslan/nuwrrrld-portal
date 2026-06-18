import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import stripe from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();
  const stripeCustomerId = user?.publicMetadata?.stripe_customer_id as string | undefined;

  if (!stripeCustomerId) {
    return NextResponse.json({ error: "no billing account found" }, { status: 404 });
  }

  const origin = req.nextUrl.origin;

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${origin}/dashboard/billing`,
  });

  return NextResponse.json({ url: session.url });
}
