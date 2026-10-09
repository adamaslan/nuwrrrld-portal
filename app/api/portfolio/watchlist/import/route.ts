import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { enqueueSignalRefreshMany } from "@/lib/signal-queue";
import {
  addManyToWatchlist,
  countWatchlist,
  findExistingWatchlistTickers,
  WatchlistCapError,
} from "@/lib/watchlist-store";
import {
  IMPORT_RATE_LIMIT,
  IMPORT_RATE_WINDOW_MS,
  ImportHttpError,
  MAX_REJECTED_SAMPLE,
  MAX_WATCHLIST_SIZE,
  allowedOriginsFromEnv,
  checkRequestOrigin,
  classifyFormat,
  isJsonContentType,
  parseImportBody,
  readJsonCapped,
  resolveAgainstUniverse,
  universeLookupKeys,
} from "@/lib/watchlist-import";

// Auth: Clerk session (edge matcher in proxy.ts covers /api/portfolio/watchlist(.*)).
// userId comes only from auth(); the body has no user field.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const originError = checkRequestOrigin(req.headers, allowedOriginsFromEnv());
  if (originError) return NextResponse.json({ error: originError }, { status: 403 });
  if (!isJsonContentType(req.headers)) {
    return NextResponse.json({ error: "json_required" }, { status: 415 });
  }

  const limit = rateLimit(`watchlist-import:${userId}`, IMPORT_RATE_LIMIT, IMPORT_RATE_WINDOW_MS);
  if (!limit.ok) {
    const retryAfter = Math.max(1, Math.ceil((limit.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const { tickers, dryRun } = parseImportBody(await readJsonCapped(req.body));
    const format = classifyFormat(tickers);

    const universeRows = format.candidates.length
      ? await sql`
          SELECT ticker FROM ticker_universe
          WHERE active AND ticker = ANY(${universeLookupKeys(format.candidates)}::text[])
        `
      : [];
    const universe = new Set(universeRows.map((r) => r.ticker as string));
    const { accepted, unknown } = resolveAgainstUniverse(format.candidates, universe);

    const existing = await findExistingWatchlistTickers(userId, accepted);
    const toAdd = accepted.filter((t) => !existing.has(t));

    const current = await countWatchlist(userId);
    if (current + toAdd.length > MAX_WATCHLIST_SIZE) {
      return NextResponse.json(
        { error: "watchlist_cap", cap: MAX_WATCHLIST_SIZE, current, wouldAdd: toAdd.length },
        { status: 422 },
      );
    }

    const added = dryRun ? toAdd : await addManyToWatchlist(userId, toAdd, MAX_WATCHLIST_SIZE);
    if (!dryRun) await enqueueSignalRefreshMany(added, userId);

    console.info(
      `watchlist.import userId=${userId} added=${added.length} rejected=${
        format.invalid + format.cryptoUnsupported + unknown.length
      } dryRun=${dryRun}`,
    );
    return NextResponse.json(
      {
        added,
        skipped: {
          already_present: accepted.length - toAdd.length,
          unknown_symbol: unknown.length,
          invalid: format.invalid,
          crypto_unsupported: format.cryptoUnsupported,
        },
        // Only values that already passed normalizeTicker; malformed input is counted, never echoed.
        rejectedSample: unknown.slice(0, MAX_REJECTED_SAMPLE),
        dryRun,
      },
      { status: !dryRun && added.length > 0 ? 201 : 200 },
    );
  } catch (err) {
    if (err instanceof ImportHttpError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    if (err instanceof WatchlistCapError) {
      return NextResponse.json({ error: "watchlist_cap", cap: MAX_WATCHLIST_SIZE }, { status: 422 });
    }
    console.error("Watchlist import failed", err);
    return NextResponse.json({ error: "watchlist unavailable" }, { status: 503 });
  }
}
