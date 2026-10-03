/**
 * GET /api/paper/version — what commit and policy version this deployment is
 * actually running (docs/paper-trading-v3.md F2/§5.2 item 4).
 *
 * The 2026-09-29 "first v2 trade" ran v1 thresholds under a v2 label: the PR
 * that fixed the workflow merged at 03:13:37Z, Vercel's build finished at
 * 03:15:06Z, and the manual trigger hit the route at 03:15:08Z — 2 seconds
 * after "done", not after "live". `.github/workflows/paper-portfolios.yml`
 * polls this endpoint until `sha` matches `github.sha` before calling the run
 * route, so a run can no longer execute against a deploy that hasn't finished
 * rolling out. No auth: a git SHA and a policy-version string carry no
 * sensitive information, and the workflow needs to poll it before it has
 * anything else to authenticate with.
 */
import { NextResponse } from "next/server";
import { PAPER_POLICY_VERSION } from "@/lib/shared/paper-policy";

export async function GET() {
  return NextResponse.json({
    // Vercel sets this automatically on every deployment — no secret, no
    // manual wiring. Falls back to "unknown" outside Vercel (local dev).
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown",
    policyVersion: PAPER_POLICY_VERSION,
  });
}
