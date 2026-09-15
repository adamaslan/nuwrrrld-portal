/**
 * GET /api/paper/[account] — one account's book: positions, weights, P&L,
 * and its last 20 orders. docs/council-paper-portfolios.md §6, Phase 7.
 *
 * Public (cached), same rationale as /api/paper/accounts.
 */
import { NextResponse } from "next/server";
import { getAccount, getPositions, listOrders, getLatestRun } from "@/lib/paper-db";
import { getLivePrices } from "@/lib/live-price-db";
import { PAPER_ACCOUNTS, type PaperAccount } from "@/lib/shared/paper-policy";
import { buildAccountDetailView, type AccountDetailVM, type AccountMetrics } from "@/lib/shared/paper-view";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<PaperAccount, { data: AccountDetailVM; expiresAt: number }>();

function isValidAccount(value: string): value is PaperAccount {
  return (PAPER_ACCOUNTS as string[]).includes(value);
}

async function generate(account: PaperAccount): Promise<AccountDetailVM | null> {
  const dbAccount = await getAccount(account);
  if (!dbAccount) return null;

  const [positions, recentOrders, run] = await Promise.all([
    getPositions(account),
    listOrders(account, 20),
    getLatestRun(account, "settle"),
  ]);
  const prices = await getLivePrices(positions.map((p: { ticker: string }) => p.ticker));
  const metrics = (run?.detail?.metrics as AccountMetrics | undefined) ?? null;

  return buildAccountDetailView(dbAccount, positions, prices, metrics, recentOrders);
}

export async function GET(_req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account: accountParam } = await params;
  if (!isValidAccount(accountParam)) {
    return NextResponse.json({ error: `unknown account "${accountParam}"` }, { status: 404 });
  }
  const account = accountParam;

  const cached = cache.get(account);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.data);
  }

  try {
    const data = await generate(account);
    if (!data) return NextResponse.json({ error: "account not seeded yet" }, { status: 404 });
    cache.set(account, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[paper/${account}] error`, err);
    return NextResponse.json({ error: "paper portfolio unavailable" }, { status: 503 });
  }
}
