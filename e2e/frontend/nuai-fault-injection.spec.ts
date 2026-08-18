import { test, expect } from "@playwright/test";

// /dashboard/* is Clerk-gated at the edge (see middleware.ts:
// isProtectedRoute). This project (`frontend` in playwright.config.ts) runs
// with storageState pointed at e2e/auth.setup.ts's saved session, so every
// test here starts already signed in — no per-test login, no cookie copied
// out of devtools. Run `npm run test:e2e:login` once to (re)create it.
test.describe("Nu AI (/dashboard/nuai) frontend resiliency", () => {
  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (exception) => {
      throw new Error(`Unhandled client exception: ${exception.message}`);
    });
  });

  test("EXPOSE: OpenRouter HTTP 429 leaves the error unrendered or the button stuck disabled", async ({ page }) => {
    await page.route("**/api/nuai", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: "rate_limited" }),
      }),
    );

    await page.goto("/dashboard/nuai");
    await page.getByPlaceholder("Ask Nu AI…").fill("Explain today's signals");

    const sendButton = page.getByRole("button", { name: "↑" });
    await sendButton.click();

    // NuAIChat's catch block only sets `error` from `err.message`, which for
    // a plain 429 (no thrown Error before the !res.ok check) becomes
    // "HTTP 429" — verify that string actually reaches the DOM rather than
    // being swallowed, and that the send button re-enables afterward.
    await expect(page.locator(".nuai-error")).toContainText("429");
    await expect(sendButton).toBeEnabled();
  });

  test("EXPOSE: a stalled SSE stream leaves the typing indicator running forever", async ({ page }) => {
    // route.fulfill() always completes the response with the given body —
    // there is no way to "fulfil and never close" with it, so the original
    // version of this test (a single fulfill() call) sent a finite response
    // and never actually simulated a stall. Caught by CodeRabbit review;
    // confirmed against Playwright's docs before fixing.
    //
    // A route handler genuinely stalls a connection by never calling
    // fulfill()/continue()/abort() at all — the request stays pending until
    // something external ends it (here, the test's own assertion timeout
    // below), which is what a real stalled upstream looks like from the
    // client's point of view.
    await page.route("**/api/nuai", () => {
      // Deliberately no fulfill/continue/abort — see comment above.
    });

    await page.goto("/dashboard/nuai");
    await page.getByPlaceholder("Ask Nu AI…").fill("What's the market tone?");
    await page.getByRole("button", { name: "↑" }).click();

    // This IS wired into required CI (--project=frontend in e2e-resiliency.yml),
    // so a genuinely-failing assertion needs test.fail(). Two stacked reasons
    // it fails today, not one: (a) NuAIChat has no client-side stream
    // timeout, so .nuai-typing would never clear even if the test reached
    // it; (b) the E2E test user has no Pro entitlement
    // (playwright-todo.md: "give the test user a subscription tier"), so
    // /dashboard/nuai currently redirects to /pricing before the input ever
    // renders — confirmed locally: page.getByPlaceholder times out because
    // the page is /pricing, not /dashboard/nuai. Fixing the entitlement gap
    // will surface (a) as the test's real failure mode; fixing (a) alone
    // will not make this pass while (b) still redirects. If either gets
    // fixed and this starts passing, Playwright reports "unexpected pass" —
    // remove test.fail() then, don't assume both gaps closed at once.
    test.fail();
    await expect(page.locator(".nuai-typing")).not.toBeVisible({ timeout: 15_000 });
  });

  test("EXPOSE: a 403 upgrade_required response surfaces the specific upgrade copy, not a raw HTTP 403", async ({ page }) => {
    await page.route("**/api/nuai", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "upgrade_required" }),
      }),
    );

    await page.goto("/dashboard/nuai");
    await page.getByPlaceholder("Ask Nu AI…").fill("hello");
    await page.getByRole("button", { name: "↑" }).click();

    await expect(page.locator(".nuai-error")).toContainText(/Pro subscription/i);
  });
});
