import { test, expect } from "@playwright/test";

// Mirrors the DepStatus union in app/api/health/route.ts.
type DepStatus = "ok" | "degraded" | "down" | "not_configured";

test.describe("Backend dependency health", () => {
  test("every dependency is reachable and configured", async ({ request }) => {
    const res = await request.get("/api/health");
    const body = await res.json();

    // Print the whole verdict on failure — it contains statuses and latencies,
    // never key material (see app/api/health/route.ts).
    const summary = JSON.stringify(body, null, 2);

    expect(res.status(), `health returned 503:\n${summary}`).toBe(200);

    for (const dep of ["mcp", "neon", "stripe", "openrouter", "clerk"] as const) {
      const status: DepStatus = body[dep].status;
      expect(status, `${dep} is ${status}:\n${summary}`).toBe("ok");
    }
  });

  test("EXPOSE: latency budget — a dependency slow enough to time out user requests", async ({ request }) => {
    const body = await (await request.get("/api/health")).json();
    const BUDGET_MS = 2_000;
    for (const dep of ["mcp", "neon", "stripe", "openrouter"] as const) {
      const latency = body[dep].latencyMs;
      if (latency === null) continue; // not measured / not configured
      expect(latency, `${dep} took ${latency}ms (budget ${BUDGET_MS}ms)`).toBeLessThan(BUDGET_MS);
    }
  });

  test("EXPOSE: frontend renders a usable page when /api/health reports down", async ({ page }) => {
    // Two independent bugs were found while re-verifying this test against
    // CodeRabbit's "known-failing test wired into required CI" finding:
    //
    // 1. This project has no `storageState` (see playwright.config.ts), so
    //    page.goto("/dashboard") hits Clerk's sign-in redirect, never the
    //    actual dashboard — the mocked /api/health response was never
    //    reaching the component this test claims to check. Fixed: this project
    //    now depends on auth-setup (see playwright.config.ts).
    // 2. getByRole("alert") was matching Next.js's own built-in
    //    `#__next-route-announcer__` — a visually-hidden, always-empty
    //    role="alert" element every Next.js page ships for screen-reader
    //    route announcements. It matched on ANY navigation and said nothing
    //    about health state. Fixed: assert on the dedicated
    //    data-testid="health-banner" the dashboard now renders (see
    //    app/dashboard/HealthBanner.tsx), never the generic role="alert".
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          status: "down",
          neon: { status: "down", latencyMs: null },
          mcp: { status: "ok", latencyMs: 40 },
          stripe: { status: "ok", latencyMs: 120 },
          openrouter: { status: "ok", latencyMs: 90 },
          clerk: { status: "ok", latencyMs: null },
        }),
      }),
    );
    await page.goto("/dashboard");
    // HealthBanner fetches /api/health on mount and, seeing neon "down",
    // renders the banner. This is now a real end-to-end check of the
    // outage-degradation path — see docs/e2e.md §4.
    await expect(page.getByTestId("health-banner")).toBeVisible();
  });
});
