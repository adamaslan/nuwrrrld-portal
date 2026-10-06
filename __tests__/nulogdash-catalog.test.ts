import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_WORKFLOW_CATALOG, MODAL_APP_CATALOG } from "@/lib/nulogdash-catalog";

const ROOT = join(__dirname, "..");

// The catalog is hand-written, so these tests are the only thing that notices
// a workflow or Modal app being added, removed, or renamed without the
// console learning about it.
describe("nulogdash catalog", () => {
  it("covers every workflow file in .github/workflows", () => {
    const onDisk = readdirSync(join(ROOT, ".github/workflows")).filter((f) => f.endsWith(".yml"));
    const catalogued = GITHUB_WORKFLOW_CATALOG.map((e) => e.id);
    expect(onDisk.filter((f) => !catalogued.includes(f))).toEqual([]);
    expect(catalogued.filter((id) => !onDisk.includes(id))).toEqual([]);
  });

  it("points every entry at a source file that exists", () => {
    for (const entry of [...GITHUB_WORKFLOW_CATALOG, ...MODAL_APP_CATALOG]) {
      expect(existsSync(join(ROOT, entry.source)), entry.source).toBe(true);
    }
  });

  it("gives every entry at least one sub-feature and a trigger", () => {
    for (const entry of [...GITHUB_WORKFLOW_CATALOG, ...MODAL_APP_CATALOG]) {
      expect(entry.subFeatures.length, entry.id).toBeGreaterThan(0);
      expect(entry.trigger.length, entry.id).toBeGreaterThan(0);
    }
  });

  it("only links entries to pipelines that write pipeline_run_log", () => {
    const linked = [...GITHUB_WORKFLOW_CATALOG, ...MODAL_APP_CATALOG]
      .filter((e) => e.pipeline)
      .map((e) => e.pipeline);
    expect(new Set(linked)).toEqual(
      new Set(["followed-tickers", "followed-tickers-judge", "precompute-ai"]),
    );
  });
});
