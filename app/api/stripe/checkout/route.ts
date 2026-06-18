import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import stripe, { PRICES } from "@/lib/stripe";
import { TRIAL_DAYS } from "@nwf/lib/subscription";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();
  const stripeCustomerId = user?.publicMetadata?.stripe_customer_id as string | undefined;

  const body = await req.json().catch(() => ({}));
  const plan: 'monthly' | 'annual' = body.plan === 'annual' ? 'annual' : 'monthly';
  const priceId = PRICES[plan];

  if (!priceId) {
    return NextResponse.json({ error: `price not configured for plan: ${plan}` }, { status: 500 });
  }

  const origin = req.headers.get('origin') ?? 'https://financial.nuwrrrld.com';

  const sessionParams: Parameters<typeof stripe.checkout.sessions.create>[0] = {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: { clerk_user_id: userId },
    },
    success_url: `${origin}/dashboard?checkout=success`,
    cancel_url: `${origin}/pricing?checkout=cancelled`,
    metadata: { clerk_user_id: userId },
    // Collect payment method upfront; charge after trial.
    payment_method_collection: 'if_required',
  };

  // Attach to existing Stripe customer if we have one — keeps billing history clean.
  if (stripeCustomerId) {
    sessionParams.customer = stripeCustomerId;
  } else {
    sessionParams.customer_email = user?.emailAddresses?.[0]?.emailAddress;
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

  return NextResponse.json({ url: session.url });
}
