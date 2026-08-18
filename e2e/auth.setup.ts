import { test as setup, expect } from "@playwright/test";
import { clerkSetup } from "@clerk/testing/playwright";
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

/** Clerk's fixed verification code for reserved `+clerk_test` addresses.
 *  Not a secret — it is the same public value for every Clerk instance, and
 *  it only works for test addresses that never receive real email. */
const CLERK_TEST_OTP = "424242";

setup("authenticate", async ({ page }) => {
  setup.skip(isFresh(STORAGE_STATE_PATH), "cached session is under 6 days old — see e2e/auth.setup.ts");

  if (!EMAIL || !PASSWORD) {
    throw new Error(
      "E2E_CLERK_TEST_EMAIL / E2E_CLERK_TEST_PASSWORD not set. " +
        "Create a dedicated Clerk test user (never a real user's credentials) " +
        "and set both in .env.local. See docs/e2e.md §7 and `npm run test:e2e:login`.",
    );
  }

  // Resolves the instance's Frontend API URL from CLERK_SECRET_KEY, which the
  // Clerk testing helpers need. Cheap, and harmless if nothing downstream
  // uses it.
  await clerkSetup();

  await page.goto("/sign-in");

  // NOTE: deliberately NOT calling setupClerkTestingToken({ page }) here.
  // It installs a Playwright route handler that re-issues every Clerk FAPI
  // request through route.fetch(); with the new-device email-code step in
  // play that interception swallows the OTP submission and the flow stalls
  // on /sign-in/client-trust forever. Verified both ways against the live
  // dev instance: without it, the same flow reaches /dashboard.
  //
  // Bot protection isn't a problem for us because E2E_CLERK_TEST_EMAIL is a
  // reserved Clerk `+clerk_test` address, which is exempt by design. If that
  // ever changes to a normal address, the token helper (and a different OTP
  // strategy) will be needed again.

  // `exact: true` matters: Clerk's sign-in card also renders social buttons
  // whose accessible name ends in "Continue" ("Sign in with Google Continue"),
  // so a loose /continue/i matches two elements and Playwright's strict mode
  // fails rather than picking one. Verified against the live Clerk UI.
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // Target the input by name, not getByLabel(/password/i) — Clerk renders a
  // "Show password" toggle button whose accessible name also matches, so the
  // loose locator resolves to two elements and strict mode fails.
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  // Clerk challenges sign-ins from an unrecognized device with an emailed
  // code, which a headless run can never read. E2E_CLERK_TEST_EMAIL must
  // therefore be a Clerk *test* address (the reserved `+clerk_test` pattern),
  // for which Clerk skips real delivery and accepts the fixed code below.
  // See .env.example and playwright-todo.md blocker #2.
  // Race guard: after the password step Clerk lands on /sign-in/factor-one
  // and only *then* navigates to the client-trust step. Checking isVisible()
  // immediately returns false against factor-one, the branch is skipped, and
  // the waitForURL below hangs until timeout. Wait for whichever of the two
  // terminal states arrives first instead.
  const codeInput = page.getByRole("textbox", { name: /verification code/i });
  await Promise.race([
    codeInput.waitFor({ state: "visible", timeout: 15_000 }).catch(() => null),
    page.waitForURL(/\/dashboard/, { timeout: 15_000 }).catch(() => null),
  ]);

  if (await codeInput.isVisible().catch(() => false)) {
    // Clerk's OTP field is a segmented input: .fill() sets the value without
    // firing the per-digit key events its controller listens for, so the code
    // silently stays empty. Type it instead.
    //
    // Do NOT click "Continue" afterwards: Clerk auto-submits the moment the
    // last digit lands, so by the time a click resolves the element is
    // detached and the click throws against a stale page. Typing is the whole
    // interaction — the waitForURL below is what confirms it worked.
    await codeInput.click();
    await page.keyboard.type(CLERK_TEST_OTP, { delay: 80 });
  }

  // /dashboard is the Clerk-protected landing point (middleware.ts); a
  // successful redirect there is the actual proof sign-in completed, not
  // just that the form submitted without a client error.
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
  await expect(page.locator("body")).not.toContainText(/sign in/i);

  await page.context().storageState({ path: STORAGE_STATE_PATH });
});
