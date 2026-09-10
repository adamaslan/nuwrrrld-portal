import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * The nulogdash admin console, end-to-end.
 *
 * WHY THIS EXISTS when __tests__/nulogdash-admin.test.ts already covers the
 * gate exhaustively: those tests call `isNulogdashAdmin` / `canPerformAdminAction`
 * as pure functions against hand-built identities. They prove the predicates are
 * correct. They cannot prove the predicates are *reached* — that page.tsx calls
 * notFound() on the failure branch, that the MFA branch renders MfaNotice, that
 * TriggerControls is genuinely absent from the DOM rather than merely disabled.
 * A refactor that dropped `if (!isNulogdashAdmin(user)) notFound()` would leave
 * every unit test green and hand the console to anyone signed in.
 *
 * SAFETY CONTRACT — read before adding a test here.
 * This suite is READ-ONLY and must stay that way. It must never click "Dry run"
 * or "Run live", because both reach lib/nulogdash-actions.ts, which makes a real
 * authenticated POST to a real pipeline route (spending model quota and writing
 * a pipeline_run_log row). Assertions here are about what is *rendered*, never
 * about what happens when it's activated. The last test in this file enforces
 * that contract mechanically.
 *
 * The signed-in identity is E2E_CLERK_TEST_EMAIL (see e2e/auth.setup.ts), which
 * is listed in NULOGDASH_ADMIN_EMAILS and has no second factor enrolled — the
 * exact combination that exercises the allowlisted-but-un-MFA'd branch, the one
 * a live admin actually lands in first.
 */

const CONSOLE_PATH = "/dashboard/nulogdash";
const PIPELINES_PATH = "/dashboard/nulogdash/pipelines";

/** Accessible names of every control in TriggerControls that reaches a Server
 *  Action. Kept in one place so the safety test below and the MFA test agree on
 *  what "a mutating control" means. */
const MUTATING_CONTROLS = [/dry run/i, /run live/i];

test.describe("nulogdash console — admin access", () => {
  test("an allowlisted admin reaches the console instead of a 404", async ({ page }) => {
    const res = await page.goto(CONSOLE_PATH);

    // page.tsx calls notFound() for a non-admin, which Next renders as a real
    // 404 response — so the status code, not just the URL, is the assertion
    // that matters. A redirect to /sign-in would mean the stored session died.
    expect(res?.status(), "expected 200 — a 404 means the admin gate rejected the e2e user").toBe(200);
    await expect(page).toHaveURL(new RegExp(`${CONSOLE_PATH}$`));
    await expect(page.getByRole("heading", { name: "nulogdash", level: 1 })).toBeVisible();
  });

  test("both console sections are reachable from the tab strip", async ({ page }) => {
    await page.goto(CONSOLE_PATH);

    const pipelinesTab = page.getByRole("link", { name: "Pipeline runs" });
    await expect(pipelinesTab).toBeVisible();
    await pipelinesTab.click();

    await expect(page).toHaveURL(new RegExp(`${PIPELINES_PATH}$`));
    await expect(page.getByRole("heading", { name: "Pipeline runs", level: 1 })).toBeVisible();

    // aria-current is how a screen reader learns which section it's in; a tab
    // strip that never marks the active tab is a real a11y regression and
    // nothing else in the suite would catch it.
    await expect(pipelinesTab).toHaveAttribute("aria-current", "page");

    await page.getByRole("link", { name: "Feature sweep" }).click();
    await expect(page).toHaveURL(new RegExp(`${CONSOLE_PATH}$`));
  });

  test("the pipelines tab renders its run table without a session-cookie dependency", async ({ page }) => {
    // The feature sweep reads .nulogdash/latest.json off disk and the pipelines
    // tab reads pipeline_run_log from Neon. Either can legitimately be empty, so
    // assert the page *rendered its own shell* rather than asserting on rows —
    // a test that needs seeded data is a test that will rot.
    const res = await page.goto(PIPELINES_PATH);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Recent runs" })).toBeVisible();
  });
});

test.describe("nulogdash console — MFA gate on mutating actions", () => {
  test("an admin without a second factor is told why, on both tabs", async ({ page }) => {
    // MfaNotice is rendered by the sweep page; the pipelines page states the
    // same restriction in its own copy. Both matter: an admin who lands on
    // either tab should understand the missing buttons, not assume a bug.
    await page.goto(CONSOLE_PATH);
    await expect(
      page.getByText("Two-factor authentication required for admin actions."),
    ).toBeVisible();

    await page.goto(PIPELINES_PATH);
    await expect(page.getByText(/read-only here/i)).toBeVisible();
  });

  test("no pipeline can be triggered from the UI without MFA", async ({ page }) => {
    await page.goto(PIPELINES_PATH);

    // The pipeline cards must still render — this is the difference between
    // "correctly read-only" and "the page failed to load", which an absence-only
    // assertion cannot tell apart. Waiting for the table also guarantees the
    // cards above it have rendered before we assert nothing is there.
    await expect(page.getByRole("heading", { name: "Recent runs" })).toBeVisible();

    // TriggerControls is not rendered at all when canTrigger is false (it is
    // gated by `{canTrigger && <TriggerControls .../>}`), so these must be
    // absent from the DOM — not merely disabled. A `disabled` button would mean
    // the control shipped to a client that could re-enable it in devtools.
    for (const name of MUTATING_CONTROLS) {
      await expect(
        page.getByRole("button", { name }),
        `a mutating control matching ${name} rendered for an admin without MFA`,
      ).toHaveCount(0);
    }

    // The live-run confirmation input is the second half of the same control.
    await expect(page.getByRole("textbox", { name: /to confirm/i })).toHaveCount(0);
  });
});

test.describe("nulogdash console — signed out", () => {
  // Drop the shared admin session for this block only. Everything above runs
  // with e2e/auth.setup.ts's storageState; here we want a cold browser, because
  // the redirect-to-sign-in branch is unreachable with a session present.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a signed-out visitor is sent to sign-in, not shown the console", async ({ page }) => {
    await page.goto(CONSOLE_PATH);

    // page.tsx redirects to /sign-in?redirect_url=... before the admin check, so
    // an anonymous visitor never learns whether the route exists.
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByRole("heading", { name: "nulogdash", level: 1 })).toHaveCount(0);
  });

  test("the pipelines tab is gated the same way as the sweep", async ({ page }) => {
    // Asserted separately because it is a separate page component with its own
    // copy of the guard — the sweep passing says nothing about this one.
    await page.goto(PIPELINES_PATH);
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe("nulogdash e2e — safety contract", () => {
  test("this suite contains no code that activates a mutating control", () => {
    // A guard on the tests themselves, not on the app. The risk this file
    // carries is that someone later adds `await page.getByRole("button",
    // { name: /dry run/i }).click()` to "check it works" — which would fire a
    // real pipeline run against whatever database the run points at, on every
    // CI job, forever. Unit tests cover the action's internals
    // (__tests__/nulogdash-actions.test.ts); this tier must stay read-only.
    //
    // test.info().file is Playwright's own absolute path for the running spec —
    // used instead of import.meta.url, which this CommonJS project cannot parse.
    const source = readFileSync(test.info().file, "utf8");

    // Look only at the executable half of the file — the prose above documents
    // the very patterns being banned, and must not trip its own guard.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");

    expect(code, "a .click() on a trigger control would fire a real pipeline run").not.toMatch(
      /getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*\/(dry run|run live)/i,
    );
    expect(code, "this tier must never import the pipeline Server Actions").not.toMatch(
      /from\s+["']@\/lib\/nulogdash-(actions|trigger)["']/,
    );
  });
});
