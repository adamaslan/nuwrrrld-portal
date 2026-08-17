import { test as setup, expect } from "@playwright/test";
import { clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";
import fs from "node:fs";
import { STORAGE_STATE_PATH } from "./storage-state";

/**
 * Signs in a real Clerk test user once and persists the resulting session to
 * STORAGE_STATE_PATH. Every `frontend` test then starts already-authenticated
 * instead of running the sign-in flow per test — Playwright's documented
 * pattern for auth reuse (https://playwright.dev/docs/auth).
 *
 * Reused across local runs (see STALE_AFTER_MS below) and re-run once per CI
 * job, so "logged in for a week" means: the file on disk survives across
 * `playwright test` invocations on your machine for up to a week before this
 * setup re-authenticates automatically. It is not one browser process kept
 * open for a week — Clerk session JWTs are short-lived and refreshed
 * transparently by Clerk's client SDK as long as the underlying session
 * (the httpOnly refresh cookie) is still valid, which is what storageState
 * captures.
 */
const STALE_AFTER_MS = 6 * 24 * 60 * 60 * 1000; // 6 days — inside Clerk's default 7-day session lifetime

function isFresh(path: string): boolean {
  if (!fs.existsSync(path)) return false;
  const ageMs = Date.now() - fs.statSync(path).mtimeMs;
  return ageMs < STALE_AFTER_MS;
}

const EMAIL = process.env.E2E_CLERK_TEST_EMAIL;
const PASSWORD = process.env.E2E_CLERK_TEST_PASSWORD;

setup("authenticate", async ({ page }) => {
  setup.skip(isFresh(STORAGE_STATE_PATH), "cached session is under 6 days old — see e2e/auth.setup.ts");

  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "E2E_CLERK_TEST_EMAIL / E2E_CLERK_TEST_PASSWORD not set. " +
        "Create a dedicated Clerk test user (never a real user's credentials) " +
        "and set both in .env.local. See docs/e2e.md §7 and `npm run test:e2e:login`.",
    );
  }

  // Bypasses Clerk's bot-protection UI (CAPTCHA-equivalent) for known test
  // traffic, so the sign-in form below is not fighting an anti-automation
  // challenge it will never solve in a headless browser.
  await clerkSetup();

  await page.goto("/sign-in");
  await setupClerkTestingToken({ page });

  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /continue/i }).click();

  // /dashboard is the Clerk-protected landing point (middleware.ts); a
  // successful redirect there is the actual proof sign-in completed, not
  // just that the form submitted without a client error.
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page.locator("body")).not.toContainText(/sign in/i);

  await page.context().storageState({ path: STORAGE_STATE_PATH });
});
