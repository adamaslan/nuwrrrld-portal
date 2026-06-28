import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();
  let stripeCustomerId = user?.publicMetadata?.stripe_customer_id as string | undefined;

  // Lazy provisioning: create Stripe customer on first billing portal access.
  if (!stripeCustomerId) {
    const email = user?.emailAddresses?.[0]?.emailAddress;
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || undefined;
    const stripe = getStripe();

    try {
      const customer = await stripe.customers.create({
        email,
        name,
        metadata: { clerk_user_id: userId },
      });
      stripeCustomerId = customer.id;
    } catch (err) {
      console.error("Failed to create Stripe customer for", userId, err);
      return NextResponse.json({ error: "billing setup failed" }, { status: 500 });
    }

    try {
      const clerk = await clerkClient();
      await clerk.users.updateUserMetadata(userId, {
        publicMetadata: { stripe_customer_id: stripeCustomerId },
      });
    } catch (err) {
      console.error("Failed to write stripe_customer_id to Clerk for", userId, err);
      // Non-fatal: portal still works this session; metadata write will retry on next visit.
    }
  }

  const origin = req.nextUrl.origin;
  const stripe = getStripe();

  const session = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${origin}/dashboard/billing`,
  });

  return NextResponse.json({ url: session.url });
}
