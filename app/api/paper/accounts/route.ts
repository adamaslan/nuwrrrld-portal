/**
 * GET /api/paper/accounts — the council paper-portfolio leaderboard.
 * docs/council-paper-portfolios.md §6, Phase 7 of
 * docs/paper-portfolios-remaining-todo.md.
 *
 * Public, read-only aggregate data about simulated accounts — no user data —
 * so this follows the same unauthenticated in-memory-TTL-cache pattern as
 * app/api/council/sample/route.ts rather than the Clerk entitlement gate
 * (§6: "Public GETs ... follow the public-demo caching pattern rather than
 * the entitlement gate").
 */
import { NextResponse } from "next/server";
import { listAccounts, getLatestRun, getNavSeries, type NavPoint } from "@/lib/paper-db";
import { PAPER_ACCOUNTS, type PaperAccount } from "@/lib/shared/paper-policy";
import { buildLeaderboardView, type LeaderboardVM, type AccountMetrics } from "@/lib/shared/paper-view";

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: LeaderboardVM; expiresAt: number } | null = null;

async function generate(): Promise<LeaderboardVM> {
  const accounts = await listAccounts();
  const metricsByAccount = new Map<PaperAccount, AccountMetrics | null>();
  const latestNavByAccount = new Map<PaperAccount, NavPoint | null>();
  await Promise.all(
    PAPER_ACCOUNTS.map(async (account) => {
      const [run, [latestNav]] = await Promise.all([getLatestRun(account, "settle"), getNavSeries(account, 1)]);
      metricsByAccount.set(account, (run?.detail?.metrics as AccountMetrics | undefined) ?? null);
      latestNavByAccount.set(account, latestNav ?? null);
    }),
  );
  return buildLeaderboardView(accounts, metricsByAccount, latestNavByAccount);
}

export async function GET() {
  if (cache && cache.expiresAt > Date.now()) {
    return NextResponse.json(cache.data);
  }
  try {
    const data = await generate();
    cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return NextResponse.json(data);
  } catch (err) {
    console.error("[paper/accounts] error", err);
    return NextResponse.json({ error: "paper portfolios unavailable" }, { status: 503 });
  }
}
