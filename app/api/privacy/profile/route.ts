/**
 * GET /api/privacy/profile — GDPR Art. 15 derived view of personal data.
 * Returns a high-level summary of engagement, preferences, and derived insights
 * that the user is entitled to see about their account and usage patterns.
 */

import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import sql from "@/lib/db";
import { listPrivacyRequests } from "@/lib/privacy-requests-db";

interface TrialInfo {
  enabled?: boolean;
  started_at?: string;
  expires_at?: string;
  extended?: boolean;
  [key: string]: unknown;
}

interface EngagementMetrics {
  council_messages_total: number;
  nuai_prompts_total: number;
  watchlist_size: number;
  disclaimer_acknowledged: boolean;
}

interface ProfilePayload {
  plan: string;
  trial: TrialInfo;
  referral: {
    code: string | null;
    referrals_completed: number;
  };
  engagement: EngagementMetrics;
  interest_tags: string[];
  consent: Record<string, unknown> | null;
  /** The user's own DSAR history — GDPR Art. 15 transparency. */
  privacy_requests: unknown[];
  _errors: string[];
}

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const user = await currentUser();

  const payload: ProfilePayload = {
    plan: (user?.publicMetadata?.plan as string | undefined) ?? "unknown",
    trial: (user?.publicMetadata?.trial as Record<string, unknown>) ?? {},
    referral: {
      code: (user?.publicMetadata?.referral_code as string | null) ?? null,
      referrals_completed:
        (user?.publicMetadata?.referrals_completed as number) ?? 0,
    },
    engagement: {
      council_messages_total: 0,
      nuai_prompts_total: 0,
      watchlist_size: 0,
      disclaimer_acknowledged: false,
    },
    interest_tags: [],
    consent: null,
    privacy_requests: [],
    _errors: [],
  };

  // council_messages_total
  try {
    const result = await sql`
      SELECT count(*)::int AS count FROM council_messages m
      INNER JOIN council_sessions s ON m.session_id = s.id
      WHERE s.user_id = ${userId}
    `;
    payload.engagement.council_messages_total = Number(result[0]?.count ?? 0);
  } catch (err) {
    payload._errors.push(
      `council_messages_total: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // nuai_prompts_total (sum of tokens or count)
  try {
    const result = await sql`
      SELECT count(*)::int AS count FROM nuai_usage WHERE user_id = ${userId}
    `;
    payload.engagement.nuai_prompts_total = Number(result[0]?.count ?? 0);
  } catch (err) {
    payload._errors.push(
      `nuai_prompts_total: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // watchlist_size
  try {
    const result = await sql`
      SELECT count(*)::int AS count FROM watchlist_items WHERE user_id = ${userId}
    `;
    payload.engagement.watchlist_size = Number(result[0]?.count ?? 0);
  } catch (err) {
    payload._errors.push(
      `watchlist_size: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // disclaimer_acknowledged (any row exists)
  try {
    const result = await sql`
      SELECT count(*)::int AS count FROM disclaimer_acks WHERE user_id = ${userId}
    `;
    payload.engagement.disclaimer_acknowledged = Number(result[0]?.count ?? 0) > 0;
  } catch (err) {
    payload._errors.push(
      `disclaimer_acknowledged: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // interest_tags (distinct tickers from watchlist_items)
  try {
    const tickers = await sql`
      SELECT DISTINCT ticker FROM watchlist_items WHERE user_id = ${userId}
      ORDER BY ticker ASC
    `;
    payload.interest_tags = tickers.map((row) => `watching: ${(row as Record<string, string>).ticker}`);
    // TODO(phase-5): sector/vol enrichment
  } catch (err) {
    payload._errors.push(
      `interest_tags: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // consent: latest record
  try {
    const result = await sql`
      SELECT record FROM consent_records WHERE user_id = ${userId}
      ORDER BY created_at DESC LIMIT 1
    `;
    payload.consent =
      result.length > 0
        ? (result[0].record as Record<string, unknown>)
        : null;
  } catch (err) {
    payload._errors.push(
      `consent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  payload.privacy_requests = await listPrivacyRequests(userId);

  return NextResponse.json(payload);
}
