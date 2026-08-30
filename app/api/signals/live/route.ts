/**
 * POST /api/signals/live
 * Accepts a batch of real-time prices from the Finnhub WebSocket tier
 * (homebase/modal_finnhub_ws.py) and upserts the latest-per-ticker into
 * live_prices. Body: { prices: [{ ticker, price, tradedAt, volume? }, ...] }.
 *
 * GET /api/signals/live?ticker=NVDA — read one ticker's last price.
 *
 * Auth (POST): Bearer PORTAL_PUSH_SECRET (server-to-server) — same pattern as
 * /api/signals/refresh and /api/signals/drain. GET is unauthenticated read.
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { parseLivePriceBatch } from "@/lib/shared/live-price";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { upsertLivePrices, getLivePrice } from "@/lib/live-price-db";

export async function POST(req: NextRequest) {
  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    console.error("[signals/live] CONFIG_ERROR: PORTAL_PUSH_SECRET is not set.");
    return NextResponse.json({ error: "PORTAL_PUSH_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const rows = parseLivePriceBatch(body);
  if (rows.length === 0) {
    // Either an empty/malformed body or nothing survived validation — 400 so the
    // WS worker sees its payload was rejected rather than silently dropped.
    return NextResponse.json({ error: "no valid prices in batch" }, { status: 400 });
  }

  const written = await upsertLivePrices(rows);
  return NextResponse.json({ written, received: rows.length });
}

export async function GET(req: NextRequest) {
  const ticker = normalizeTicker(req.nextUrl.searchParams.get("ticker"));
  if (!ticker) return NextResponse.json({ error: "valid ticker required" }, { status: 400 });

  const record = await getLivePrice(ticker);
  if (!record) return NextResponse.json({ error: "no live price" }, { status: 404 });
  return NextResponse.json(record);
}
