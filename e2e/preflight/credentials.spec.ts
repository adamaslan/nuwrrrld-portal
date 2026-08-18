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
