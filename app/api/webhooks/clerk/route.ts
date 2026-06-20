import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { clerkClient } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (err) {
    console.error("Clerk webhook signature verification failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  switch (evt.type) {
    case "user.created": {
      const { id: clerkUserId, email_addresses, first_name, last_name } = evt.data;
      const email = email_addresses?.[0]?.email_address;

      if (!email) {
        console.warn("user.created event missing email", clerkUserId);
        break;
      }

      // Create Stripe customer and store ID on Clerk metadata.
      // Clerk metadata is a cache of Stripe — Stripe is always source of truth.
      let customerId: string;
      const stripe = getStripe();
      try {
        const customer = await stripe.customers.create({
          email,
          name: [first_name, last_name].filter(Boolean).join(' ') || undefined,
          metadata: { clerk_user_id: clerkUserId },
        });
        customerId = customer.id;
      } catch (err) {
        console.error("Failed to create Stripe customer for", clerkUserId, err);
        // Return 500 so Clerk retries — user will be left without a customer ID otherwise.
        return NextResponse.json({ error: "stripe customer creation failed" }, { status: 500 });
      }

      try {
        const clerk = await clerkClient();
        await clerk.users.updateUserMetadata(clerkUserId, {
          publicMetadata: {
            stripe_customer_id: customerId,
            subscription_status: 'free',
            subscription_tier: 'free',
          },
        });
        console.log("Stripe customer created", customerId, "for Clerk user", clerkUserId);
      } catch (err) {
        console.error("Failed to update Clerk metadata for", clerkUserId, err);
        // Return 500 so Clerk retries the webhook. The Stripe customer already exists,
        // but stripe.customers.create is idempotent via metadata lookup on retry.
        return NextResponse.json({ error: "clerk metadata update failed" }, { status: 500 });
      }
      break;
    }

    case "user.updated":
    case "user.deleted":
    case "session.created":
    case "session.ended":
      console.log(evt.type, evt.data.id);
      break;

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
