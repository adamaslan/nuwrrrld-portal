import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { engineGate, parseDoneLine } from "../scripts/engine-gate.mjs";

// Real hydrate.log tails: run 45720934097 (11-25 late midday cron, skipped)
// and run 45754064841 (11-26 nightly, wrote cards).
const SKIPPED_LOG = [
  "[skip] status=skipped intraday hydration: exchange session is closed",
  "[done] status=skipped written=0 calc-errors=0 post-failures=0 unservable=0 total=0",
].join("\n");
const WROTE_LOG = "[start] …\n[done] status=partial written=1992 calc-errors=0 post-failures=0 unservable=25 total=1033\n";

const ok = { event: "workflow_run", runAttempt: "1", artifactCount: "1", logText: SKIPPED_LOG, previousEngine: { status: "completed", conclusion: "success" } };

describe("engineGate", () => {
  it("skips only when the triggering hydration explicitly did nothing and the last engine run succeeded", () => {
    expect(engineGate(ok)).toEqual({ skip: true, reason: "triggering hydration reported status=skipped written=0 total=0" });
  });

  it.each([
    ["hydration wrote cards", { logText: WROTE_LOG }],
    ["a manual dispatch", { event: "workflow_dispatch" }],
    ["a re-run attempt of hydration", { runAttempt: "2" }],
    ["an unknown attempt", { runAttempt: undefined }],
    ["a missing artifact", { artifactCount: "0" }],
    ["two artifacts", { artifactCount: "2" }],
    ["an unreadable log", { logText: null }],
    ["no [done] line (hydration died)", { logText: "[skip] status=skipped intraday hydration: exchange session is closed\n" }],
    ["two [done] lines", { logText: `${SKIPPED_LOG}\n${SKIPPED_LOG}` }],
    ["a malformed [done] token", { logText: "[done] status=skipped written=0 total=0 oops" }],
    ["a duplicated field", { logText: "[done] status=skipped written=0 total=0 written=5" }],
    ["skipped but attempted symbols", { logText: "[done] status=skipped written=0 total=12" }],
    ["skipped but wrote", { logText: "[done] status=skipped written=3 total=0" }],
    ["a failed hydration", { logText: "[done] status=fail written=0 calc-errors=0 post-failures=0 unservable=0 total=0" }],
    ["the previous engine run failed", { previousEngine: { status: "completed", conclusion: "failure" } }],
    ["the previous engine run was cancelled", { previousEngine: { status: "completed", conclusion: "cancelled" } }],
    ["the previous engine run was skipped", { previousEngine: { status: "completed", conclusion: "skipped" } }],
    ["the previous engine run is still running", { previousEngine: { status: "in_progress", conclusion: "" } }],
    ["no previous engine run", { previousEngine: null }],
  ])("runs the engine for %s", (_label, change) => {
    expect(engineGate({ ...ok, ...change }).skip).toBe(false);
  });

  it("parses the real [done] line exactly", () => {
    expect(parseDoneLine(SKIPPED_LOG)).toEqual({ status: "skipped", written: "0", "calc-errors": "0", "post-failures": "0", unservable: "0", total: "0" });
  });
});

describe("scripts/engine-gate.mjs CLI", () => {
  const runCli = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "engine-gate-"));
    const out = join(dir, "out");
    const summary = join(dir, "summary");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    const log = join(dir, "hydrate.log");
    writeFileSync(log, SKIPPED_LOG);
    const r = spawnSync(process.execPath, ["scripts/engine-gate.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary,
        GATE_EVENT: "workflow_run", GATE_RUN_ATTEMPT: "1", GATE_ARTIFACT_COUNT: "1", GATE_LOG_PATH: log,
        GATE_PREV_STATUS: "completed", GATE_PREV_CONCLUSION: "success", ...env,
      },
    });
    return { code: r.status, output: readFileSync(out, "utf8"), summary: readFileSync(summary, "utf8") };
  };

  it("writes skip=true and a distinct summary line when hydration skipped", () => {
    const r = runCli({});
    expect(r.code).toBe(0);
    expect(r.output).toContain("skip=true\n");
    expect(r.summary).toContain("### Engine nightly: not run (triggering hydration reported status=skipped written=0 total=0)");
  });

  it("fails open when the artifact was not downloaded", () => {
    const r = runCli({ GATE_LOG_PATH: "/nonexistent/hydrate.log", GATE_ARTIFACT_COUNT: "0" });
    expect(r.code).toBe(0);
    expect(r.output).toContain("skip=false\n");
    expect(r.summary).toContain("### Engine nightly: running (");
  });

  it("fails open when the previous engine run failed", () => {
    const r = runCli({ GATE_PREV_CONCLUSION: "failure" });
    expect(r.output).toContain("skip=false\n");
  });
});
