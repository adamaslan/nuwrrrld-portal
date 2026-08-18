import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// The VS Code extension spawns its own Node process and does NOT inherit the
// shell that has .env.local loaded. Load it here or every preflight test
// fails in the editor while passing on the CLI. No-ops in CI, where the
// file doesn't exist and env is supplied directly by the workflow.
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

import { STORAGE_STATE_PATH } from "./e2e/storage-state";

// `||`, not `??` — .env.example ships NULOGDASH_BASE_URL with an empty value,
// and dotenv loads that as "" rather than leaving it undefined. `??` only
// falls back on null/undefined, so an empty var would set baseURL to "" and
// every page.goto("/path") fails with "Cannot navigate to invalid URL".
const BASE_URL = process.env.NULOGDASH_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // Serial locally: the frontend fault-injection tests share route mocks per
  // page and the preflight/health tiers hit real providers — same reasoning
  // as vitest's live project (fileParallelism: false). CI parallelizes via
  // shard, not via workers.
  workers: process.env.CI ? 2 : 1,
  retries: process.env.CI ? 1 : 0,
  // json always runs alongside the human-facing reporter — it's what
  // scripts/nulogdash-merge-e2e.mjs reads to fold browser-tier results into
  // .nulogdash/latest.json (tier: "browser") for the nulogdash admin
  // dashboard. See docs/wiki-portal/entity-playwright-e2e.md.
  reporter: process.env.CI
    ? [["blob"], ["github"], ["json", { outputFile: ".nulogdash/e2e-raw.json" }]]
    : [["html", { open: "never" }], ["list"], ["json", { outputFile: ".nulogdash/e2e-raw.json" }]],

  use: {
    baseURL: BASE_URL,
    // retain-on-failure, never 'on' — traces capture request headers, which
    // means Authorization: Bearer <key> lands in the artifact.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // Lets "run test" work from the gutter without a dev server already up.
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    // 180s, not 120s: a cold `next dev` on a CI runner has no .next cache and
    // compiles on first request, which has measured close to the old ceiling.
    // Note this timeout is also what surfaces a *boot* failure (a missing env
    // var throwing at module scope), and in that case it will always run the
    // full duration before reporting — so a webServer timeout is worth
    // reading as "check the [WebServer] log lines above", not just "too slow".
    timeout: 180_000,
  },

  projects: [
    // The credential gate is split by concern, so a gate blocks what actually
    // depends on it and nothing else. Previously a single `preflight` project
    // asserted Stripe keys too, which meant `auth-setup` — a Clerk sign-in
    // that never touches Stripe — could not run until STRIPE_WEBHOOK_SECRET
    // was a real value. Wrong coupling, and it made a green suite impossible
    // for reasons unrelated to what was being tested.
    //
    //   preflight ──> health ──> (nothing yet)
    //             └─> auth-setup ──> frontend
    //   preflight-billing ──> (billing tiers, when they exist)
    //   ci (independent: no browser, no webServer)

    // Core: what any tier needs — app boots, user can sign in, AI reachable.
    { name: "preflight", testMatch: /preflight\/credentials\.spec\.ts/ },

    // Billing: Stripe only. Expected to fail until docs/stripe-todo.md's
    // three unset values are supplied; deliberately gates nothing else.
    { name: "preflight-billing", testMatch: /preflight\/billing\.spec\.ts/ },

    { name: "health", testDir: "./e2e/health", dependencies: ["preflight"] },

    // CLI/subprocess integration checks (scripts/*.mjs + their GHA
    // workflows) — no browser, no webServer dependency. Independent of the
    // auth/frontend chain below.
    { name: "ci", testDir: "./e2e/ci" },

    { name: "auth-setup", testMatch: /auth\.setup\.ts/, dependencies: ["preflight"] },
    {
      name: "frontend",
      testDir: "./e2e/frontend",
      dependencies: ["auth-setup"],
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE_PATH },
    },
  ],
});
