import { test, expect } from "@playwright/test";
import { expectKeyShape } from "./shape";

/**
 * CORE credential preflight — the vars every tier needs regardless of what
 * it exercises: the app must boot (DATABASE_URL), a user must be able to
 * sign in (Clerk), and the AI routes must be reachable (OpenRouter).
 *
 * Billing credentials live in billing.spec.ts and gate only the tiers that
 * actually touch Stripe. Keeping them here made `auth-setup` unable to run
 * without a Stripe webhook secret, which it never uses — see
 * playwright.config.ts's project graph.
 */
test.describe("Credential preflight — core shape", () => {
  test("auth + AI + database keys are present and well-formed", () => {
    expectKeyShape("OPENROUTER_API_KEY", ["sk-or-v1-"]);
    expectKeyShape("CLERK_SECRET_KEY", ["sk_test_", "sk_live_"]);
    expectKeyShape("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", ["pk_test_", "pk_live_"]);
    expectKeyShape("DATABASE_URL", ["postgres://", "postgresql://"]);
  });

  test("EXPOSE: placeholder values that pass a presence check but fail at runtime", () => {
    const placeholderish = /(placeholder|changeme|your[-_]?key|xxx+|TODO)/i;
    for (const name of ["IP_HASH_SECRET"]) {
      const value = process.env[name] ?? "";
      expect(placeholderish.test(value), `${name} is still a placeholder`).toBe(false);
    }
  });

  test("EXPOSE: production running on development-tier keys", () => {
    test.skip(process.env.VERCEL_ENV !== "production", "production-only guard");
    expect(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith("pk_live_")).toBe(true);
  });

  // Inverse of the check above: this whole suite runs `next dev` on
  // localhost (playwright.config.ts's webServer), and a Clerk PRODUCTION
  // instance key is domain-locked — it refuses to load off localhost with
  // "Production Keys are only allowed for domain ...". When that happens,
  // Clerk's SDK never initializes, the sign-in page's email field never
  // renders, and e2e/auth.setup.ts's getByLabel(/email/i) times out 30s
  // later with no indication why the element doesn't exist. This is exactly
  // what happened on every CI run after the 2026-09-02 prod cutover
  // (docs/clerk-dev-to-prod.md): the GitHub secrets these keys come from got
  // pointed at the live instance. Catch it here, immediately and legibly,
  // instead of as a mystery 30s auth-setup timeout four jobs downstream.
  test("EXPOSE: E2E running against Clerk's production instance, which localhost cannot use", () => {
    test.skip(process.env.VERCEL_ENV === "production", "this check is for local/CI E2E only — see the inverse test above for prod");
    const pk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
    const sk = process.env.CLERK_SECRET_KEY ?? "";
    expect(
      pk.startsWith("pk_live_"),
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is a pk_live_ (production) key — E2E must run against " +
        "Clerk's DEVELOPMENT instance (docs/clerk-dev-to-prod.md §6: it's the only instance where " +
        "+clerk_test addresses and the fixed OTP work, and production keys are domain-locked away " +
        "from localhost). If this is CI, the E2E_CLERK_PUBLISHABLE_KEY/E2E_CLERK_SECRET_KEY GitHub " +
        "secrets (see .github/workflows/e2e-resiliency.yml) hold live keys and need resetting to the " +
        "dev-instance values — see docs/manual-setup-todo.md §5b.",
    ).toBe(false);
    expect(
      sk.startsWith("sk_live_"),
      "CLERK_SECRET_KEY is a sk_live_ (production) key — see the message above.",
    ).toBe(false);
  });
});

test.describe("Credential preflight — core liveness", () => {
  // Cheapest authenticated OpenRouter call: list models. No tokens consumed.
  test("OPENROUTER_API_KEY is accepted by the provider", async ({ request }) => {
    const res = await request.get("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    expect(res.status(), "OpenRouter rejected the key (401 = revoked/typo)").toBe(200);
  });

  test("MCP_BACKEND_URL points at a live GCP Cloud Run service", async ({ request }) => {
    const base = process.env.MCP_BACKEND_URL;
    test.skip(!base, "MCP_BACKEND_URL unset — falls back to the hardcoded default");
    const res = await request.get(`${base}/health`, { timeout: 15_000 });
    // First hit may be a cold start; 5xx here is the cold-start signature.
    expect(res.status(), "MCP backend unhealthy or cold-starting past timeout").toBe(200);
  });
});
