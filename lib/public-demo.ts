/**
 * Public council demo — backs the unauthenticated "ask the council" widget on
 * the landing page (app/api/council/public). Two halves:
 *
 *  - Quota: 1 fresh model call per IP-hash per day. Raw IPs are never stored —
 *    `hashIp` (pure, sha256) is the only thing that touches Postgres.
 *  - Cache: keyed by (ticker, date, seat), so once anyone has asked about a
 *    ticker today, every subsequent visitor gets the cached answer for free
 *    and without counting against their own quota.
 *
 * Every DB call here is guarded the same way as every other cache in this
 * repo (concept-cache-then-degrade): a read failure is a cache miss, not an
 * error, and a write failure is silently swallowed. Quota is the one
 * exception that must fail closed (see checkAndIncrementDemoQuota) — an
 * unreachable DB should not turn into unlimited free LLM calls.
 */
import sql from "@/lib/db";
import type { CouncilSeat } from "@/lib/openrouter";
import { MAX_DEMO_PER_IP_PER_DAY } from "@/lib/shared/public-demo-policy";

// Re-export so existing importers can keep resolving them from here; their
// canonical, DB-free home is lib/shared/public-demo-policy.ts.
export { hashIp, clientIpFromHeaders } from "@/lib/shared/public-demo-policy";

/**
 * Atomically check-and-increment today's quota for this IP hash. Returns
 * true if the caller is still under the daily cap (and the increment was
 * recorded), false if they've hit it. Fails CLOSED on a DB error — unlike
 * lib/council-db.ts's authenticated-user quota (which fails open, since a
 * paying/signed-in user shouldn't be blocked by a quota-table hiccup), an
 * anonymous public endpoint failing open would mean unlimited free LLM
 * calls the moment the quota table is unreachable. Not worth the risk.
 */
export async function checkAndIncrementDemoQuota(ipHash: string): Promise<boolean> {
  try {
    const rows = await sql`
      INSERT INTO public_demo_usage (ip_hash, usage_date, count)
      VALUES (${ipHash}, CURRENT_DATE, 1)
      ON CONFLICT (ip_hash, usage_date)
      DO UPDATE SET count = public_demo_usage.count + 1
      WHERE public_demo_usage.count < ${MAX_DEMO_PER_IP_PER_DAY}
      RETURNING count
    `;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** Roll back a consumed quota slot when the downstream model call fails, so a failed attempt doesn't cost the visitor their one free question. */
export async function releaseDemoQuota(ipHash: string): Promise<void> {
  try {
    await sql`
      UPDATE public_demo_usage SET count = count - 1
      WHERE ip_hash = ${ipHash} AND usage_date = CURRENT_DATE AND count > 0
    `;
  } catch {
    // non-fatal — worst case the visitor loses their slot for the day.
  }
}

export interface CachedDemoAnswer {
  answer: string;
  model: string;
}

/** Guarded read of today's cached answer for a ticker. Never throws. */
export async function getCachedDemoAnswer(ticker: string, seat: CouncilSeat): Promise<CachedDemoAnswer | null> {
  try {
    const rows = await sql`
      SELECT answer, model FROM public_demo_cache
      WHERE ticker = ${ticker} AND usage_date = CURRENT_DATE AND seat = ${seat}
      LIMIT 1
    `;
    if (!rows.length) return null;
    return { answer: rows[0].answer as string, model: rows[0].model as string };
  } catch {
    return null;
  }
}

/** Guarded write of today's answer for a ticker. Best-effort — never throws. */
export async function saveDemoAnswer(ticker: string, seat: CouncilSeat, answer: string, model: string): Promise<void> {
  try {
    await sql`
      INSERT INTO public_demo_cache (ticker, usage_date, seat, answer, model)
      VALUES (${ticker}, CURRENT_DATE, ${seat}, ${answer}, ${model})
      ON CONFLICT (ticker, usage_date, seat) DO UPDATE SET answer = EXCLUDED.answer, model = EXCLUDED.model
    `;
  } catch {
    // non-fatal — the answer is still returned to this caller, just not cached for the next one.
  }
}
