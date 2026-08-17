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
    await page.route("**/api/nuai", async (route) => {
      // Fulfil with a single SSE chunk and never close — NuAIChat's
      // consumeSSE (lib/shared/sse.ts) awaits the stream to completion with
      // no client-side timeout of its own.
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"delta":"Generating"}\n\n',
      });
    });

    await page.goto("/dashboard/nuai");
    await page.getByPlaceholder("Ask Nu AI…").fill("What's the market tone?");
    await page.getByRole("button", { name: "↑" }).click();

    // EXPECTED TO FAIL if there is no client-side stream timeout: the
    // "Nu AI is thinking…" placeholder (.nuai-typing) stays mounted
    // indefinitely instead of surfacing a retry affordance.
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
