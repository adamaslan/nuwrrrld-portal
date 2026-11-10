import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { clerkClient } from "@clerk/nextjs/server";
import { getStripe } from "@/lib/stripe";
import type { SubscriptionStatus, SubscriptionTier } from "@/lib/subscription";
import { tierFromStatus } from "@/lib/subscription";

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");

  if (!sig) {
    return NextResponse.json({ error: "missing stripe-signature" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret || webhookSecret.startsWith('whsec_placeholder')) {
    // Structured, loud failure: this is a config error, not a transient one — every
    // Stripe event (subscription created/updated/canceled, checkout completed) is
    // silently dropped until a real secret is set. Surface it clearly in logs/monitoring
    // rather than a generic 500 so it isn't mistaken for a signature-verification bug.
    console.error(
      "[stripe-webhook] CONFIG_ERROR: STRIPE_WEBHOOK_SECRET is unset or still the placeholder value. " +
      "Billing sync (subscription create/update/cancel, checkout completion) is broken until this is fixed. " +
      "Manual action required: create the webhook endpoint in the Stripe dashboard " +
      "(Developers → Webhooks → Add endpoint, pointing at /api/webhooks/stripe) and set the " +
      "resulting signing secret as STRIPE_WEBHOOK_SECRET in Vercel project env vars. See .env.example.",
    );
    return NextResponse.json({ error: "webhook not configured" }, { status: 500 });
  }

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscriptionToClerk(sub);
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const clerkUserId = session.metadata?.clerk_user_id;
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer?.id ?? null;
        if (clerkUserId && customerId) {
          // Stamp clerk_user_id on the Customer so syncSubscriptionToClerk can resolve it.
          await stripe.customers.update(customerId, {
            metadata: { clerk_user_id: clerkUserId },
          });
          // Sync subscription immediately if Stripe already created it.
          // Use the already-expanded object if available to avoid an extra API call.
          if (session.subscription) {
            const sub =
              typeof session.subscription === "string"
                ? await stripe.subscriptions.retrieve(session.subscription)
                : session.subscription;
            await syncSubscriptionToClerk(sub);
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        console.log("Payment failed for customer", invoice.customer);
        // Stripe Smart Retries handle the retry schedule; status update
        // arrives via customer.subscription.updated when it flips to past_due.
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error("Error processing Stripe event", event.type, err);
    // Every failed entitlement sync is retryable, including cancellation.
    // A 2xx here tells Stripe delivery succeeded even if Clerk never changed.
    return NextResponse.json({ error: "sync failed, will retry" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function syncSubscriptionToClerk(sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  const clerk = await clerkClient();
  // Checkout stamps the subscription binding before customer metadata. It also
  // survives customer deletion, so cancellation can still revoke access.
  let clerkUserId = sub.metadata?.clerk_user_id;
  if (!clerkUserId) {
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) throw new Error("Stripe customer deleted before entitlement sync");
    clerkUserId = customer.metadata?.clerk_user_id;
  }
  if (!clerkUserId) {
    // Do not acknowledge success: checkout may stamp the binding later.
    throw new Error("Stripe subscription has no Clerk user binding yet");
  }

  const rawStatus = sub.status as SubscriptionStatus;
  const tier: SubscriptionTier = tierFromStatus(rawStatus);

  await clerk.users.updateUserMetadata(clerkUserId, {
    publicMetadata: {
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      subscription_status: rawStatus,
      subscription_tier: tier,
      trial_end: sub.trial_end ?? undefined,
      current_period_end: sub.items?.data?.[0]?.current_period_end,
    },
  });

  console.log("Synced subscription", sub.id, rawStatus, tier, "to Clerk user", clerkUserId);
}
