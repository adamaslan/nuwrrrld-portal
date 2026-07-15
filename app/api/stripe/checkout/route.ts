import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe, PRICES } from "@/lib/stripe";
import { TRIAL_DAYS } from "@/lib/subscription";

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

  if (!priceId || priceId.includes('placeholder')) {
    // Config error, not a transient failure — surface it loudly so a bad price ID
    // doesn't read as a generic Stripe outage. See .env.example for the fix.
    console.error(
      `[stripe-checkout] CONFIG_ERROR: STRIPE_PRICE_${plan.toUpperCase()} is unset or still a placeholder value. ` +
      `Checkout for the ${plan} plan will 400/500 until a real Stripe price ID is set in Vercel env vars.`,
    );
    return NextResponse.json({ error: `price not configured for plan: ${plan}` }, { status: 500 });
  }

  const origin = req.nextUrl.origin;
  const stripe = getStripe();

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
