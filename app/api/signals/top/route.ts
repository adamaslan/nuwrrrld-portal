/**
 * GET /api/signals/top — the ranked ticker-card universe.
 *
 * The read side of the coverage pipeline (`docs/universe-scale-hydration.md`
 * step 4). `topCards()` has existed since the pipeline landed but had no
 * caller, so nothing in the product could see the ranking; this is that caller.
 *
 * Deliberately a thin route: every decision it makes — scope, horizon, limit,
 * what counts as "strong" — lives in `lib/shared/universe-policy.ts` so it can
 * be unit-tested without `DATABASE_URL`. The route's own job is auth, parse,
 * delegate, shape.
 *
 * Query params (all optional):
 *   ?universe=stock|etf|all   default `stock` — see resolveUniverseScope
 *   ?horizon=t1|t2            default `t1`
 *   ?limit=<1..200>           default 50
 */
import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { topCards } from "@/lib/ticker-cards-db";
import {
  cardAgeDays,
  resolveHorizon,
  resolveLimit,
  resolveUniverseScope,
  summarizeRanking,
} from "@/lib/shared/universe-policy";

export async function GET(req: NextRequest) {
  const { userId } = await auth();

  // Same dual gate as /api/signals/digest: a Clerk session, or a trusted
  // server-to-server caller bearing PORTAL_PUSH_SECRET. The precompute-AI
  // batch reads this ranking to pick its subjects and has no Clerk session.
  const secret = process.env.PORTAL_PUSH_SECRET;
  const isInternal = bearerTokenMatches(req.headers.get("authorization"), secret);

  if (!userId && !isInternal) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const universe = resolveUniverseScope(params.get("universe"));
  const horizon = resolveHorizon(params.get("horizon"));
  const limit = resolveLimit(params.get("limit"));

  const cards = await topCards(horizon, limit, universe);

  // `topCards` returns [] on a DB failure rather than throwing, so an empty
  // list is genuinely ambiguous here — no cards vs. no database. The
  // distinction that matters to a reader is carried by `coverage` below
  // rather than by inventing a 503 the data layer never reported.
  const summary = summarizeRanking(cards);

  return NextResponse.json({
    ok: true,
    query: { universe, horizon, limit },
    ...summary,
    cards: cards.map((c) => ({
      ticker: c.ticker,
      universe: c.universe,
      score: c.score,
      action: c.action,
      direction: c.tokens.direction,
      tokens: c.tokens,
      dataQuality: c.dataQuality,
      // Zero until the grounding pack is compiled — the join is live, the
      // pack is empty. Surfaced rather than hidden so a reader can tell
      // "no rules for this state" from "grounding not built yet".
      groundingHits: c.groundingHits,
      barDate: c.barDate,
      ageDays: cardAgeDays(c.barDate),
      source: c.source,
    })),
  });
}
