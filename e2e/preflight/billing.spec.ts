import { test, expect } from "@playwright/test";
import { expectKeyShape } from "./shape";

/**
 * BILLING credential preflight — Stripe only. Deliberately separate from
 * credentials.spec.ts so that a missing/placeholder Stripe secret blocks the
 * tiers that actually exercise checkout, and nothing else.
 *
 * Previously these assertions lived in the core preflight, which meant
 * `auth-setup` (a Clerk sign-in that never touches Stripe) could not run
 * until STRIPE_WEBHOOK_SECRET was a real value. That is the wrong coupling:
 * a gate should block what depends on it, not everything.
 *
 * `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ANNUAL`, and `PORTAL_PUSH_SECRET`
 * are known-unset as of 2026-08-17 — see docs/stripe-todo.md for where each
 * one comes from. Until they're filled in, this project is expected to fail,
 * and only the billing-dependent tiers are held back by it.
 */
test.describe("Credential preflight — billing shape", () => {
  test("Stripe keys are present and well-formed", () => {
    expectKeyShape("STRIPE_SECRET_KEY", ["sk_test_", "sk_live_"]);
    expectKeyShape("STRIPE_WEBHOOK_SECRET", ["whsec_"]);
  });

  test("EXPOSE: placeholder billing values that pass a presence check but fail at runtime", () => {
    const placeholderish = /(placeholder|changeme|your[-_]?key|xxx+|TODO)/i;
    for (const name of [
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_MONTHLY",
      "STRIPE_PRICE_ANNUAL",
      "PORTAL_PUSH_SECRET",
    ]) {
      const value = process.env[name] ?? "";
      expect(placeholderish.test(value), `${name} is still a placeholder`).toBe(false);
    }
  });

  test("EXPOSE: production running on a development-tier Stripe key", () => {
    test.skip(process.env.VERCEL_ENV !== "production", "production-only guard");
    expect(process.env.STRIPE_SECRET_KEY!.startsWith("sk_live_")).toBe(true);
  });
});

test.describe("Credential preflight — billing liveness", () => {
  // Balance retrieval is free and does not mutate anything.
  test("STRIPE_SECRET_KEY is accepted by Stripe", async ({ request }) => {
    const res = await request.get("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    expect(res.status()).toBe(200);
  });
});
