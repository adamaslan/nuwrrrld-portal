/**
 * GET /api/paper/[account]/watchlist — the account's chosen candidate pool
 * (§2.1), current version, with `in_seed_book`/`active` flags.
 * docs/council-paper-portfolios.md §6, Phase 7. Public (cached).
 */
import { NextResponse } from "next/server";
import { listActiveWatchlist } from "@/lib/paper-db";
import { PAPER_ACCOUNTS, type PaperAccount } from "@/lib/shared/paper-policy";
import { buildWatchlistView, type WatchlistEntryVM } from "@/lib/shared/paper-view";

const CACHE_TTL_MS = 30 * 60 * 1000; // watchlists change a few times a year (§5.1) — a long TTL is fine
const cache = new Map<PaperAccount, { data: { entries: WatchlistEntryVM[]; version: number | null }; expiresAt: number }>();

function isValidAccount(value: string): value is PaperAccount {
  return (PAPER_ACCOUNTS as string[]).includes(value);
}

export async function GET(_req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account: accountParam } = await params;
  if (!isValidAccount(accountParam)) {
    return NextResponse.json({ error: `unknown account "${accountParam}"` }, { status: 404 });
  }
  const account = accountParam;

  const cached = cache.get(account);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ account, ...cached.data });
  }

  try {
    const entries = await listActiveWatchlist(account);
    const view = buildWatchlistView(entries);
    cache.set(account, { data: view, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json({ account, ...view });
  } catch (err) {
    console.error(`[paper/${account}/watchlist] error`, err);
    return NextResponse.json({ error: "watchlist unavailable" }, { status: 503 });
  }
}
