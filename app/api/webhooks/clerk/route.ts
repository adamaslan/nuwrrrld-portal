import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  let evt;
  try {
    evt = await verifyWebhook(req);
  } catch (err) {
    console.error("Clerk webhook signature verification failed:", err);
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  // Stripe customer provisioning is lazy — created on first billing action.
  // These events are logged for observability; handlers added here as needed.
  console.log(evt.type, evt.data.id);

  return NextResponse.json({ received: true });
}
