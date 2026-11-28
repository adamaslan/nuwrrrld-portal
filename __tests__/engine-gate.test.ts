import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { engineGate, parseDoneLine, pickEvidenceRun } from "../scripts/engine-gate.mjs";

// Real hydrate.log tails: run 45720934097 (11-25 late midday cron, skipped)
// and run 45754064841 (11-26 nightly, wrote cards).
const SKIPPED_LOG = [
  "[skip] status=skipped intraday hydration: exchange session is closed",
  "[done] status=skipped written=0 calc-errors=0 post-failures=0 unservable=0 total=0",
].join("\n");
const WROTE_LOG = "[start] …\n[done] status=partial written=1992 calc-errors=0 post-failures=0 unservable=25 total=1033\n";

const computed = { status: "completed", conclusion: "success", compute: "success" };
const gateSkip = { status: "completed", conclusion: "success", compute: "skipped" };

const ok = { event: "workflow_run", runAttempt: "1", artifactCount: "1", logText: SKIPPED_LOG, previousRuns: [computed] };

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
    ["the previous engine run failed", { previousRuns: [{ status: "completed", conclusion: "failure", compute: "failure" }] }],
    ["the previous engine run was cancelled", { previousRuns: [{ status: "completed", conclusion: "cancelled", compute: "" }] }],
    ["the previous engine run was skipped", { previousRuns: [{ status: "completed", conclusion: "skipped", compute: "" }] }],
    ["the previous engine run is still running", { previousRuns: [{ status: "in_progress", conclusion: "", compute: "" }] }],
    ["no previous engine run", { previousRuns: [] }],
    ["a green previous run whose compute step never ran and nothing older proves one", { previousRuns: [gateSkip] }],
    ["a gate-skip run sitting on top of a failed compute", { previousRuns: [gateSkip, { status: "completed", conclusion: "failure", compute: "failure" }] }],
    ["consecutive gate skips over a failed compute", { previousRuns: [gateSkip, gateSkip, { status: "completed", conclusion: "failure", compute: "failure" }] }],
    ["a green run with no compute evidence recorded", { previousRuns: [{ status: "completed", conclusion: "success" }] }],
    ["a missing marker separator", { logText: "[done]status=skipped written=0 total=0" }],
    ["a tab-less glued marker with the real fields", { logText: "[done]status=skipped written=0 calc-errors=0 post-failures=0 unservable=0 total=0" }],
  ])("runs the engine for %s", (_label, change) => {
    expect(engineGate({ ...ok, ...change }).skip).toBe(false);
  });

  it("lets gate skips pass over to the compute that preceded them", () => {
    expect(engineGate({ ...ok, previousRuns: [gateSkip, gateSkip, computed] }).skip).toBe(true);
  });

  it("does not accept a dry run as compute evidence: dry runs are never in the eligible list", () => {
    // failure -> successful manual dry run -> no-op hydration. The workflow lists only
    // workflow_run runs, so the dry run is absent and the failed compute is the newest.
    const failed = { status: "completed", conclusion: "failure", compute: "failure" };
    expect(engineGate({ ...ok, previousRuns: [failed] }).skip).toBe(false);
    // Even if a dry run's shape (green, compute step skipped) leaked in, it is a gate-skip shape
    // and only passes over to the failure behind it.
    expect(engineGate({ ...ok, previousRuns: [gateSkip, failed] }).skip).toBe(false);
  });

  it("parses the real [done] line exactly", () => {
    expect(parseDoneLine(SKIPPED_LOG)).toEqual({ status: "skipped", written: "0", "calc-errors": "0", "post-failures": "0", unservable: "0", total: "0" });
  });
});

describe("pickEvidenceRun", () => {
  it("returns the newest run that is not a green gate skip", () => {
    expect(pickEvidenceRun([gateSkip, gateSkip, computed])).toEqual(computed);
    expect(pickEvidenceRun([])).toBeNull();
    expect(pickEvidenceRun([gateSkip])).toBeNull();
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
        GATE_PREV_RUNS: JSON.stringify([computed]), ...env,
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
    const r = runCli({ GATE_PREV_RUNS: JSON.stringify([{ status: "completed", conclusion: "failure", compute: "failure" }]) });
    expect(r.output).toContain("skip=false\n");
  });

  it("fails open on a failed compute behind consecutive gate skips", () => {
    const failed = { status: "completed", conclusion: "failure", compute: "failure" };
    const r = runCli({ GATE_PREV_RUNS: JSON.stringify([gateSkip, gateSkip, failed]) });
    expect(r.output).toContain("skip=false\n");
  });

  it("fails open on unparseable run history", () => {
    expect(runCli({ GATE_PREV_RUNS: "not json" }).output).toContain("skip=false\n");
    expect(runCli({ GATE_PREV_RUNS: "" }).output).toContain("skip=false\n");
  });

  it("rejects the glued marker from the review", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-gate-"));
    const log = join(dir, "hydrate.log");
    writeFileSync(log, "[done]status=skipped written=0 total=0\n");
    expect(runCli({ GATE_LOG_PATH: log }).output).toContain("skip=false\n");
  });
});

describe("malformed completion marker (review of e66c45a)", () => {
  it("does not skip on `[done]status=skipped written=0 total=0`", () => {
    const r = engineGate({ ...ok, logText: "[done]status=skipped written=0 total=0" });
    expect(r.skip).toBe(false);
    expect(parseDoneLine("[done]status=skipped written=0 total=0")).toBeNull();
  });

  it("counts glued marker lines so a valid line beside one is still ambiguous", () => {
    expect(parseDoneLine(`[done]status=skipped written=0 total=0\n${SKIPPED_LOG}`)).toBeNull();
  });
});

describe("staged workflow patch (docs/staged/engine-nightly-gate.patch)", () => {
  const patch = readFileSync("docs/staged/engine-nightly-gate.patch", "utf8");

  it("applies cleanly to the committed workflow", () => {
    const r = spawnSync("git", ["apply", "--check", "docs/staged/engine-nightly-gate.patch"], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it("lists only automated runs, so a manual dry run is never compute evidence", () => {
    expect(patch).toContain("--event workflow_run");
    expect(patch).toContain("GATE_PREV_RUNS");
  });

  it("emits a recovery notification only when the engine step succeeded", () => {
    expect(patch).toContain("computed: ${{ steps.engine.outcome == 'success' }}");
    expect(patch).toContain("needs.engine.result == 'success' && needs.engine.outputs.computed == 'true'");
  });
});
