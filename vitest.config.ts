import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(__dirname, ".") };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["__tests__/**/*.test.ts"],
          // Live tests make real model calls against the free-tier quota and
          // are slow + legitimately flaky. They are their own project, never
          // part of the default fast suite.
          exclude: ["__tests__/live/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "live",
          environment: "node",
          include: ["__tests__/live/**/*.live.test.ts"],
          setupFiles: ["./test/live-setup.ts"],
          // Free-tier providers rate-limit on concurrency; one file at a time
          // keeps 429s down to the ones the fallback chain is meant to absorb
          // rather than manufacturing our own.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
          retry: 1,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "components",
          environment: "jsdom",
          setupFiles: ["./test/setup.ts"],
          include: ["components/**/*.test.tsx", "app/**/*.test.tsx"],
        },
      },
      {
        resolve: { alias },
        test: {
          // Phase 8 of docs/openrouter-migration-and-db-parity-plan.md: runs
          // every lib/*-db.ts module's exported functions against BOTH a
          // Neon branch and an in-memory SQLite DB built from the generated
          // schema, asserting shape-equality. Needs node:sqlite (Node 22+)
          // and — for the Neon side — DATABASE_URL pointed at a throwaway
          // branch, so it's a separate project rather than part of "unit".
          name: "db-parity",
          environment: "node",
          include: ["__tests__/db-parity/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
