import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getLatestHoldFoldCache, saveHoldFoldCache } from "@/lib/holdfold-cache-db";
import { mapSignalsToHoldFold } from "@/lib/shared/holdfold-map";
import type { HoldFoldPayload } from "@/lib/shared/holdfold-map";

// Types moved to lib/shared/holdfold-map.ts (the brief route needs them too, and
// a lib module importing from app/api was backwards). Re-exported so existing
// importers of "@/app/api/holdfold/route" keep resolving.
export type { HoldFoldVerdict, HoldFoldPayload } from "@/lib/shared/holdfold-map";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 8_000;

async function fetchSignals(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// In-process L1 cache (15 min) in front of the durable Neon cache — survives
// within one serverless instance's lifetime; Neon survives cold starts.
const L1_TTL_MS = 15 * 60 * 1000;
let l1Cache: { payload: HoldFoldPayload; expiresAt: number } | null = null;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  if (l1Cache && l1Cache.expiresAt > Date.now()) {
    return NextResponse.json(l1Cache.payload);
  }

  const dbCached = await getLatestHoldFoldCache();
  if (dbCached) {
    l1Cache = { payload: dbCached, expiresAt: Date.now() + L1_TTL_MS };
    return NextResponse.json(dbCached);
  }

  const raw = await fetchSignals();
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "signals unavailable" }, { status: 503 });
  }

  const payload = mapSignalsToHoldFold(raw);
  if (!payload) {
    return NextResponse.json({ error: "invalid signals shape" }, { status: 502 });
  }

  l1Cache = { payload, expiresAt: Date.now() + L1_TTL_MS };
  await saveHoldFoldCache(payload);
  return NextResponse.json(payload);
}
