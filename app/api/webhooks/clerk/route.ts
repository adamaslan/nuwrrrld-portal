import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { NextRequest, NextResponse } from "next/server";

/**
 * Clerk webhook receiver (svix-verified).
 *
 * Configured in auth-todo Phase G.1. Requires CLERK_WEBHOOK_SIGNING_SECRET
 * (whsec_...) in the environment — set via `vercel env add` after creating
 * the endpoint in Clerk.
 */
export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (err) {
    console.error("Clerk webhook signature verification failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  switch (evt.type) {
    case "user.created":
      // TODO(Stripe Phase 2): create the Stripe customer here — this is the
      // Clerk→backend user-mapping moment (see gcp3-mobile-robust-50.md, Monetization move 1).
      console.log("user.created", evt.data.id);
      break;
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
