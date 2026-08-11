import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { DISCLAIMER_HASH, DISCLAIMER_VERSION } from "@/lib/disclaimer";
import { hasAcknowledged, recordAck } from "@/lib/disclaimer-db";

/** GET: has the signed-in caller acknowledged the current disclaimer hash? */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ acknowledged: false });

  const acknowledged = await hasAcknowledged(userId, DISCLAIMER_HASH);
  return NextResponse.json({ acknowledged });
}

/** POST: record acknowledgement of the current disclaimer hash. */
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const surface = typeof body.surface === "string" ? body.surface.slice(0, 40) : undefined;

  await recordAck(userId, DISCLAIMER_HASH, DISCLAIMER_VERSION, surface);
  return NextResponse.json({ ok: true });
}
