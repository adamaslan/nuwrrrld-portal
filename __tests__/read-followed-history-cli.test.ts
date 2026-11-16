import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true }); });
function run(input: object, hash?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "followed-history-test-")); dirs.push(dir);
  const file = path.join(dir, "artifact.json"), raw = JSON.stringify(input);
  writeFileSync(file, raw);
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/read-followed-history.ts", "--artifact", file,
    "--sha256", hash ?? createHash("sha256").update(raw).digest("hex"), "--run-id", "synthetic-test",
    "--engine-sha256", "a".repeat(64), "--universe-sha256", "b".repeat(64), "--today", "2026-11-15"], { encoding: "utf8" });
}
const artifact = { format: "followed-cohort-reconstruction-v1", mode: "reconstructed_point_in_time",
  horizonPolicy: "followed-weekdays-lag1-yearend-v1", runId: "synthetic-test", engineSha256: "a".repeat(64), universeSha256: "b".repeat(64),
  decisionStart: "2026-09-01", decisionEnd: "2026-09-01", observationCutoff: "2026-11-13", priceBasis: "SYNTHETIC",
  picks: [{ id: "p1", ticker: "TEST", cohortMonth: "2026-09-01", selectedOn: "2026-09-01", inputsThrough: "2026-08-31", direction: "bull", entryPrice: 100 }],
  exits: [{ pickId: "p1", horizon: "d1", resolvedOn: "2026-09-02", exitPrice: 102, status: "measured" }],
};
describe("local historical cohort CLI", () => {
  it("consumes pinned bytes through actual scorer, without storage or network", () => {
    const result = run(artifact); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "reconstructed", pickCount: 1, scoreboard: expect.arrayContaining([expect.objectContaining({ horizon: "d1", n: 1, hits: 1, hitRatePct: null })]) });
  });
  it("fails closed before consuming unpinned bytes", () => {
    const result = run(artifact, "0".repeat(64)); expect(result.status).toBe(1);
    expect(result.stderr).toContain("artifact digest mismatch"); expect(result.stdout).toBe("");
  });
  it("does not convert a pinned pooled detector manifest into cohort data", () => {
    const result = run({ mode: "reconstructed_point_in_time", pooled_category_strength_horizon: [] });
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
  });
});
