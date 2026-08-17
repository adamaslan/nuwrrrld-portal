import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// The VS Code extension spawns its own Node process and does NOT inherit the
// shell that has .env.local loaded. Load it here or every preflight test
// fails in the editor while passing on the CLI. No-ops in CI, where the
// file doesn't exist and env is supplied directly by the workflow.
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

import { STORAGE_STATE_PATH } from "./e2e/storage-state";

const BASE_URL = process.env.NULOGDASH_BASE_URL ?? "http://localhost:3000";

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
    timeout: 120_000,
  },

  projects: [
    // Ordered so the Test Explorer tree mirrors the credential-gate pipeline:
    // preflight (keys are real) -> health (deps are up) -> auth (session is
    // fresh) -> frontend (fault injection, already signed in). `dependencies`
    // makes "run all" stop early on a bad key instead of producing forty red
    // frontend tests for the wrong reason.
    { name: "preflight", testDir: "./e2e/preflight" },
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
