/**
 * GET /api/paper/[account]/orders — the transaction log, paginated,
 * newest-first — the same rows mirrored to Firestore (§5.1).
 * docs/council-paper-portfolios.md §6, Phase 7. Public (cached per page).
 *
 * `?limit=` (default 20, max 100) and `?offset=` (default 0).
 */
import { NextResponse } from "next/server";
import { listOrders } from "@/lib/paper-db";
import { PAPER_ACCOUNTS, type PaperAccount } from "@/lib/shared/paper-policy";
import type { OrderRow } from "@/lib/paper-db";

const CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { data: OrderRow[]; expiresAt: number }>();
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

function isValidAccount(value: string): value is PaperAccount {
  return (PAPER_ACCOUNTS as string[]).includes(value);
}

export async function GET(req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account: accountParam } = await params;
  if (!isValidAccount(accountParam)) {
    return NextResponse.json({ error: `unknown account "${accountParam}"` }, { status: 404 });
  }
  const account = accountParam;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(searchParams.get("limit")) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(searchParams.get("offset")) || 0);
  const cacheKey = `${account}:${limit}:${offset}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ account, limit, offset, orders: cached.data });
  }

  try {
    const orders = await listOrders(account, limit, offset);
    cache.set(cacheKey, { data: orders, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json({ account, limit, offset, orders });
  } catch (err) {
    console.error(`[paper/${account}/orders] error`, err);
    return NextResponse.json({ error: "orders unavailable" }, { status: 503 });
  }
}
