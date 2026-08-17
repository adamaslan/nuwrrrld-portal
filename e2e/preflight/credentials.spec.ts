import { test, expect } from "@playwright/test";

/** Assert a var exists and matches an expected prefix — never logs the value. */
function expectKeyShape(name: string, prefixes: string[]): void {
  const value = process.env[name];
  expect(value, `${name} is not set`).toBeTruthy();
  expect(
    prefixes.some((p) => value!.startsWith(p)),
    `${name} does not start with any of ${prefixes.join("|")} (value not shown)`,
  ).toBe(true);
  // Catches the copy-paste classic: a trailing newline that produces
  // "Invalid character in header content [Authorization]" at request time.
  expect(value, `${name} has leading/trailing whitespace`).toBe(value!.trim());
}

test.describe("Credential preflight — shape", () => {
  test("AI + auth + billing keys are present and well-formed", () => {
    expectKeyShape("OPENROUTER_API_KEY", ["sk-or-v1-"]);
    expectKeyShape("ANTHROPIC_API_KEY", ["sk-ant-"]);
    expectKeyShape("CLERK_SECRET_KEY", ["sk_test_", "sk_live_"]);
    expectKeyShape("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", ["pk_test_", "pk_live_"]);
    expectKeyShape("STRIPE_SECRET_KEY", ["sk_test_", "sk_live_"]);
    expectKeyShape("STRIPE_WEBHOOK_SECRET", ["whsec_"]);
    expectKeyShape("DATABASE_URL", ["postgres://", "postgresql://"]);
  });

  test("EXPOSE: placeholder values that pass a presence check but fail at runtime", () => {
    const placeholderish = /(placeholder|changeme|your[-_]?key|xxx+|TODO)/i;
    for (const name of [
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_PRICE_MONTHLY",
      "STRIPE_PRICE_ANNUAL",
      "PORTAL_PUSH_SECRET",
      "IP_HASH_SECRET",
    ]) {
      const value = process.env[name] ?? "";
      expect(placeholderish.test(value), `${name} is still a placeholder`).toBe(false);
    }
  });

  test("EXPOSE: production running on development-tier keys", () => {
    test.skip(process.env.VERCEL_ENV !== "production", "production-only guard");
    expect(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith("pk_live_")).toBe(true);
    expect(process.env.STRIPE_SECRET_KEY!.startsWith("sk_live_")).toBe(true);
  });
});

test.describe("Credential preflight — liveness", () => {
  // Cheapest authenticated OpenRouter call: list models. No tokens consumed.
  test("OPENROUTER_API_KEY is accepted by the provider", async ({ request }) => {
    const res = await request.get("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    });
    expect(res.status(), "OpenRouter rejected the key (401 = revoked/typo)").toBe(200);
  });

  // Balance retrieval is free and does not mutate anything.
  test("STRIPE_SECRET_KEY is accepted by Stripe", async ({ request }) => {
    const res = await request.get("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    expect(res.status()).toBe(200);
  });

  test("MCP_BACKEND_URL points at a live GCP Cloud Run service", async ({ request }) => {
    const base = process.env.MCP_BACKEND_URL;
    test.skip(!base, "MCP_BACKEND_URL unset — falls back to the hardcoded default");
    const res = await request.get(`${base}/health`, { timeout: 15_000 });
    // First hit may be a cold start; 5xx here is the cold-start signature.
    expect(res.status(), "MCP backend unhealthy or cold-starting past timeout").toBe(200);
  });
});
