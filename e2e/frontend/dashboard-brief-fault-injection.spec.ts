import { test, expect } from "@playwright/test";

/**
 * /dashboard's "Daily Brief · Nu AI" card (app/dashboard/DashboardCockpit.tsx)
 * is the OpenRouter-backed feature that actually lives on the main dashboard
 * after login — POST /api/brief internally calls fetchWithModelFallback()
 * (lib/openrouter.ts), which walks FREE_MODEL_CHAIN on failure. This suite
 * exercises that path the same way nuai-fault-injection.spec.ts exercises
 * /dashboard/nuai: mock the route, drive the UI, assert the rendered error
 * state — not a network layer already covered by e2e/ci/refresh-free-models.spec.ts.
 *
 * Same auth setup as every other `frontend` spec: this project depends on
 * auth-setup and runs with storageState already signed in (see
 * playwright.config.ts).
 *
 * NOTE on scope, re: "check free-model refresh via Modal": the Modal.com cron
 * deployment that runs scripts/refresh-free-models.mjs on a schedule
 * (docs/modal-deployment-and-local-triggering.md) is an external compute
 * platform this repo doesn't control the UI of — there is no browser surface
 * for Playwright to drive, and no webhook back into this app to assert
 * against. That job's actual contract (CLI exit codes, --dry-run safety,
 * MIN_WORKING floor) is already covered at the right layer in
 * e2e/ci/refresh-free-models.spec.ts. What IS reachable from a browser, and
 * therefore belongs here, is what happens on THIS page when the OpenRouter
 * call the free-model chain feeds into fails or degrades — that's what the
 * tests below cover.
 */
test.describe("Dashboard daily brief (/dashboard, OpenRouter-backed) frontend resiliency", () => {
  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (exception) => {
      throw new Error(`Unhandled client exception: ${exception.message}`);
    });
  });

  test("EXPOSE: OpenRouter/FREE_MODEL_CHAIN exhaustion (500) surfaces the retry card, not a stuck loading state", async ({ page }) => {
    await page.route("**/api/brief", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "all models in FREE_MODEL_CHAIN failed" }),
      }),
    );

    await page.goto("/dashboard");
    const generateButton = page.locator(".cockpit-brief-btn");
    await generateButton.click();

    // DashboardCockpit's generateBrief() maps any !res.ok to a fixed message
    // (app/dashboard/DashboardCockpit.tsx:110-112) — it does not surface the
    // upstream error body, so this asserts the actual UI contract rather than
    // the mocked response's own text.
    await expect(page.locator(".cockpit-brief-error")).toContainText("Brief unavailable");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("EXPOSE: a 403 (free-tier user, no Pro entitlement) shows upgrade copy, not a generic failure", async ({ page }) => {
    await page.route("**/api/brief", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "upgrade_required" }),
      }),
    );

    await page.goto("/dashboard");
    await page.locator(".cockpit-brief-btn").click();

    await expect(page.locator(".cockpit-brief-error")).toContainText(/upgrade/i);
  });

  test("EXPOSE: a 200 with an empty brief body reports 'empty', not a silent success", async ({ page }) => {
    // Reproduces the failure mode this repo has already hit once with a real
    // model (a fault-injection precedent, not a hypothetical): an OpenRouter
    // call that returns 200 with no usable content. DashboardCockpit checks
    // `!finalText` after parsing (line 123) specifically to catch this.
    await page.route("**/api/brief", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brief: "" }),
      }),
    );

    await page.goto("/dashboard");
    await page.locator(".cockpit-brief-btn").click();

    await expect(page.locator(".cockpit-brief-error")).toContainText(/empty/i);
  });

  test("real /api/brief call renders a non-empty brief without an unhandled client exception", async ({ page }) => {
    // Deliberately NOT mocked — this is the one test in this file proving the
    // real OpenRouter + FREE_MODEL_CHAIN path produces a usable brief, same
    // non-mocking rationale as portfolio-liveness.spec.ts / signals-liveness.spec.ts.
    // Skips rather than fails when there's no live key, since a missing
    // OPENROUTER_API_KEY is an environment gap already covered by
    // preflight/credentials.spec.ts, not a regression in this feature.
    test.skip(!process.env.OPENROUTER_API_KEY, "OPENROUTER_API_KEY not configured");

    await page.goto("/dashboard");
    await page.locator(".cockpit-brief-btn").click();

    // Model calls can legitimately take a while through the fallback chain;
    // give it real headroom rather than the default 5s action timeout.
    await expect(page.locator(".cockpit-brief-card")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".cockpit-brief-text")).not.toBeEmpty();
  });
});
