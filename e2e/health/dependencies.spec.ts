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
    // EXPECTED TO FAIL today — DashboardCockpit does not currently render
    // any role="alert" banner when a backend dependency is down. This test
    // documents the gap; see docs/e2e.md §4.
    await expect(page.getByRole("alert")).toBeVisible();
  });
});
