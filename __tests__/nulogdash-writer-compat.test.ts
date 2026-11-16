import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadLatestReport } from "@/lib/nulogdash-report";

describe("report reader compatibility with existing writers", () => {
  it("accepts the committed sweep inventory and actual network-free Playwright merger output", () => {
    const root = mkdtempSync(join(tmpdir(), "nld-writer-"));
    try {
      mkdirSync(join(root, ".nulogdash"));
      const inventory = JSON.parse(readFileSync(join(process.cwd(), "docs/nulogdash-inventory.json"), "utf8"));
      const run = {
        runId: "fixture-local-only", runAt: "2026-11-11T23:00:00Z", gitSha: "fixture", branch: "fixture",
        baseUrl: "http://localhost:3000", tiers: ["api"],
        results: [
          ...inventory.features.map((f: { slug: string; label: string; method: string; path: string; dependencies: string[] }) => ({
            feature: f.slug, label: f.label, entrypoints: [`${f.method} ${f.path}`], dependencies: f.dependencies,
            tier: "api", latencyMs: null, status: "blocked", reason: "Offline compatibility fixture; not executed",
          })),
          ...inventory.excluded.map((f: { feature: string; path: string; reason: string }) => ({
            feature: f.feature, label: f.feature, entrypoints: [f.path], dependencies: [],
            tier: null, latencyMs: null, status: "not_run", reason: `excluded: ${f.reason}`,
          })),
        ], excluded: inventory.excluded, driftWarnings: inventory.driftWarnings,
      };
      const path = join(root, ".nulogdash/latest.json");
      writeFileSync(path, JSON.stringify(run));
      expect(loadLatestReport(path).status).toBe("ready");
      writeFileSync(join(root, ".nulogdash/e2e-raw.json"), JSON.stringify({ suites: [{
        file: "e2e/frontend/admin-fixture.spec.ts", specs: ["expected", "skipped", "unexpected", "flaky"].map(status => ({
          title: `Offline fixture ${status}`, tests: [{ projectName: "frontend", status, results: [{ duration: 15 }] }],
        })),
      }] }));
      const child = spawnSync(process.execPath, [join(process.cwd(), "scripts/nulogdash-merge-e2e.mjs")], {
        cwd: root, encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, NULOGDASH_BASE_URL: "http://localhost:3000" },
      });
      // The fixture intentionally contains one failed outcome. This is the
      // merger's failure reporting, not a provider/model/browser invocation.
      expect(child.status).toBe(1);
      const loaded = loadLatestReport(path);
      expect(loaded.status).toBe("ready");
      if (loaded.status !== "ready") throw new Error("writer compatibility failed");
      expect(loaded.run.results.filter(row => row.tier === "browser").map(row => row.status)).toEqual(["pass", "not_run", "fail", "pass"]);
      expect(loaded.run.results.filter(row => row.tier === "api")).toHaveLength(inventory.features.length);
      expect(loaded.run.excluded).toEqual(inventory.excluded);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
