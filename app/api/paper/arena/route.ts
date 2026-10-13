/**
 * GET /api/paper/arena — all eight paper accounts side by side: judged
 * metrics, rebased equity curves, the merged trade feed with reasons, and a
 * per-account reason breakdown. Public, read-only, cached — same pattern as
 * /api/paper/accounts.
 */
import { NextResponse } from "next/server";
import { loadArena } from "@/lib/paper-arena";
import type { ArenaVM } from "@/lib/shared/paper-arena-view";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: ArenaVM; expiresAt: number } | null = null;

export async function GET() {
  if (cache && cache.expiresAt > Date.now()) return NextResponse.json(cache.data);
  try {
    const data = await loadArena();
    cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return NextResponse.json(data);
  } catch (err) {
    console.error("[paper/arena] error", err);
    return NextResponse.json({ error: "paper arena unavailable" }, { status: 503 });
  }
}
