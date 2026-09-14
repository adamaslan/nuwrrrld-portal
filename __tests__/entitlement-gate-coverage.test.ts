import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "tinyglobby";

/**
 * Structural guard: every feature gate must resolve tier through
 * `resolveTier()`/`parseSubscriptionMetadataWithAdmin()` (lib/subscription-admin),
 * never through bare `tierFromStatus()` (lib/subscription).
 *
 * Why this exists as a test rather than a code review note: PR #119 added the
 * admin override and wired it into all eight API routes, then recorded itself
 * — in docs/wiki-portal/entity-billing.md — as covering "every hasEntitlement
 * call site". It had missed all six gated *dashboard pages*. The result was a
 * split-brain gate that is genuinely hard to spot by hand: the API said pro and
 * the page said free, so an admin saw Pro on /dashboard and was still bounced to
 * /pricing by every feature they clicked.
 *
 * A grep-shaped test catches the next omission at the moment it is written,
 * which is the only time it is cheap to fix. Same reasoning as
 * scripts/check-shared-drift.mjs.
 */

const REPO_ROOT = join(__dirname, "..");

/**
 * The only files permitted to call bare `tierFromStatus()`.
 *
 * The two billing pages display the user's *real* Stripe state — showing a
 * fabricated "Pro" plan to an admin with no subscription would be actively
 * misleading, so they deliberately bypass the override. The Stripe webhook
 * writes real Stripe state into Clerk and must never record an admin override
 * as though it came from Stripe.
 */
const ALLOWED_BARE_TIER_FROM_STATUS = new Set([
  "app/dashboard/upgrade/page.tsx",
  "app/dashboard/billing/page.tsx",
  "app/api/webhooks/stripe/route.ts",
]);

function sourceFiles(): string[] {
  return globSync(["app/**/*.ts", "app/**/*.tsx", "lib/**/*.ts", "lib/**/*.tsx"], {
    cwd: REPO_ROOT,
    ignore: ["lib/subscription.ts", "lib/subscription-admin.ts", "**/*.test.ts", "**/*.test.tsx"],
  }).sort();
}

describe("entitlement gate coverage", () => {
  it("only the billing surfaces and the Stripe webhook call bare tierFromStatus()", () => {
    const offenders = sourceFiles().filter((rel) => {
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      return /\btierFromStatus\s*\(/.test(src) && !ALLOWED_BARE_TIER_FROM_STATUS.has(rel);
    });

    expect(
      offenders,
      `These files gate on bare tierFromStatus(), so a nulogdash admin resolves to 'free' ` +
        `there even though every API route grants pro. Use resolveTier(status, user) from ` +
        `@/lib/subscription-admin instead — or, if the file genuinely must show real Stripe ` +
        `state, add it to ALLOWED_BARE_TIER_FROM_STATUS with a comment saying why.`,
    ).toEqual([]);
  });

  it("every file gating on hasEntitlement() derives its tier with the admin override", () => {
    const offenders = sourceFiles().filter((rel) => {
      if (ALLOWED_BARE_TIER_FROM_STATUS.has(rel)) return false;
      const src = readFileSync(join(REPO_ROOT, rel), "utf8");
      if (!/\bhasEntitlement\s*\(/.test(src)) return false;
      return !/\b(resolveTier|parseSubscriptionMetadataWithAdmin)\s*\(/.test(src);
    });

    expect(
      offenders,
      `These files call hasEntitlement() without resolving tier through ` +
        `lib/subscription-admin, so the admin Pro override never applies to them.`,
    ).toEqual([]);
  });

  it("guards the real gated surfaces, not an empty set", () => {
    // Without this, a bad glob would make both tests above pass vacuously.
    const gated = sourceFiles().filter((rel) =>
      /\bhasEntitlement\s*\(/.test(readFileSync(join(REPO_ROOT, rel), "utf8")),
    );
    expect(gated.length).toBeGreaterThanOrEqual(12);
  });
});
