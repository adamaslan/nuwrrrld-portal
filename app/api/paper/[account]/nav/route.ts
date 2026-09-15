/**
 * GET /api/paper/[account]/nav — NAV series for charting.
 * docs/council-paper-portfolios.md §6, Phase 7. Public (cached).
 */
import { NextResponse } from "next/server";
import { getNavSeries } from "@/lib/paper-db";
import { PAPER_ACCOUNTS, type PaperAccount } from "@/lib/shared/paper-policy";
import { buildNavSeriesView, type NavSeriesPointVM } from "@/lib/shared/paper-view";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<PaperAccount, { data: NavSeriesPointVM[]; expiresAt: number }>();

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
    return NextResponse.json({ account, series: cached.data });
  }

  try {
    const points = await getNavSeries(account, 400);
    const series = buildNavSeriesView(points);
    cache.set(account, { data: series, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json({ account, series });
  } catch (err) {
    console.error(`[paper/${account}/nav] error`, err);
    return NextResponse.json({ error: "NAV series unavailable" }, { status: 503 });
  }
}
