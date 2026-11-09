import { afterEach, describe, expect, it, vi } from "vitest";

const required = ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_ANNUAL", "OPENROUTER_API_KEY", "PORTAL_PUSH_SECRET", "CRON_SECRET", "IP_HASH_SECRET"];
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("email provider environment schema", () => {
  it.each(["BREVO", "BrEvO", "RESEND"])("normalizes %s consistently with the selector", async (value) => {
    vi.resetModules();
    for (const key of required) vi.stubEnv(key, "fixture-only");
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@127.0.0.1:1/fixture");
    vi.stubEnv("ALERT_EMAIL_PROVIDER", value);
    const { env } = await import("@/lib/env");
    expect(env.ALERT_EMAIL_PROVIDER).toBe(value.toLowerCase());
  });
});
