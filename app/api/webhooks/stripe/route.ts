export const runtime = 'edge';
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
    console.error("STRIPE_WEBHOOK_SECRET not configured");
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
    // For checkout.session.completed, return 500 so Stripe retries — a missed
    // entitlement sync here is unrecoverable without a retry.
    if (event.type === "checkout.session.completed") {
      return NextResponse.json({ error: "sync failed, will retry" }, { status: 500 });
    }
    // For other events, return 200 to avoid infinite Stripe retries on non-critical paths.
  }

  return NextResponse.json({ received: true });
}

async function syncSubscriptionToClerk(sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

  // Resolve Clerk user via clerk_user_id stored on the Stripe customer at creation.
  const clerk = await clerkClient();
  const stripe = getStripe();
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return;

  const clerkUserId = (customer as Stripe.Customer).metadata?.clerk_user_id;
  if (!clerkUserId) {
    console.warn("No clerk_user_id on Stripe customer", customerId);
    return;
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
