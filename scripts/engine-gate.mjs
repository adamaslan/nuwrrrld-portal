#!/usr/bin/env node
/**
 * engine-gate — decide whether Engine nightly may skip because the hydration run
 * that triggered it explicitly did nothing (`[done] status=skipped written=0 …
 * total=0`, the shape hydrate-universe.yml's Summarize step already accepts as a
 * clock-gate skip). It never reads the database or engine output.
 *
 * Skips only when every input is present and unambiguous; anything else runs
 * the engine as before. Inputs (env), all supplied by the workflow:
 *   GATE_EVENT           github.event_name
 *   GATE_RUN_ATTEMPT     github.event.workflow_run.run_attempt
 *   GATE_ENGINE_ATTEMPT  github.run_attempt (this engine run; a retry always computes)
 *   GATE_ARTIFACT_COUNT  hydrate-log artifacts on the triggering run
 *   GATE_LOG_PATH        downloaded hydrate.log (may be missing)
 *   GATE_PREV_RUNS       JSON, newest first: the engine-nightly runs triggered by
 *                        workflow_run on the default branch (never manual dispatches,
 *                        so a dry run cannot count), each
 *                        { status, conclusion, compute } where compute is the
 *                        "Run the engine (shadow)" step's conclusion
 * Writes skip=true|false and reason=… to GITHUB_OUTPUT and one summary line.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The single `[done]` line's key=value fields, or null when there is not exactly one.
 * Every line that starts with the marker counts, so a glued `[done]status=…` line is
 * ambiguous rather than ignored; the marker must be followed by whitespace.
 */
export function parseDoneLine(logText) {
  const lines = String(logText ?? "").split(/\r?\n/).filter((l) => l.startsWith("[done]"));
  if (lines.length !== 1) return null;
  const m = /^\[done\]\s+(.+)$/.exec(lines[0]);
  if (!m) return null;
  const fields = {};
  for (const token of m[1].trim().split(/\s+/)) {
    const m = /^([a-z-]+)=(\S+)$/.exec(token);
    if (!m || m[1] in fields) return null;
    fields[m[1]] = m[2];
  }
  return fields;
}

/**
 * The run whose compute the gate may rely on: the newest run that is not a green gate
 * skip (success with the engine step skipped). A gate skip computed nothing, so it neither
 * proves nor disproves the engine; the run behind it does. Null when there is none.
 */
export function pickEvidenceRun(runs) {
  for (const r of Array.isArray(runs) ? runs : []) {
    const gateSkip = r?.status === "completed" && r?.conclusion === "success" && r?.compute === "skipped";
    if (!gateSkip) return r ?? null;
  }
  return null;
}

/**
 * @param {{ event?: string, runAttempt?: string, engineAttempt?: string, artifactCount?: string, logText?: string | null,
 *           previousRuns?: Array<{ status?: string, conclusion?: string, compute?: string }> }} input
 * @returns {{ skip: boolean, reason: string }}
 */
export function engineGate({ event, runAttempt, engineAttempt, artifactCount, logText, previousRuns }) {
  const run = (reason) => ({ skip: false, reason });
  if (event !== "workflow_run") return run(`trigger is ${event || "unknown"}, not workflow_run`);
  // A re-run attempt can leave the artifact from another attempt; only the first is unambiguous.
  if (runAttempt !== "1") return run(`triggering hydration attempt is ${runAttempt || "unknown"}, not 1`);
  // A retry of this engine run may follow a failed compute that history cannot see.
  if (engineAttempt !== "1") return run(`engine run attempt is ${engineAttempt || "unknown"}, not 1`);
  if (artifactCount !== "1") return run(`found ${artifactCount || "no"} hydrate-log artifacts, need exactly 1`);
  // A green run is not proof of a compute: a gate skip is green with the engine step skipped.
  // Require the preceding eligible run that actually computed to have succeeded; a failed,
  // cancelled, running or job-skipped one gets its next chance to recompute.
  const prev = pickEvidenceRun(previousRuns);
  if (!prev || prev.status !== "completed" || prev.conclusion !== "success" || prev.compute !== "success") {
    return run(`no successful engine compute to rely on (latest relevant run is ${prev?.status || "missing"}/${prev?.conclusion || "none"}, compute ${prev?.compute || "none"})`);
  }
  if (logText == null) return run("hydrate.log could not be read");
  const done = parseDoneLine(logText);
  if (!done) return run("hydrate.log has no single well-formed [done] line");
  if (done.status !== "skipped" || done.written !== "0" || done.total !== "0") {
    return run(`hydration reported status=${done.status} written=${done.written} total=${done.total}`);
  }
  return { skip: true, reason: "triggering hydration reported status=skipped written=0 total=0" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  let logText = null;
  try {
    if (env.GATE_LOG_PATH) logText = readFileSync(env.GATE_LOG_PATH, "utf8");
  } catch {
    /* missing artifact: engineGate fails open */
  }
  let previousRuns = [];
  try {
    previousRuns = JSON.parse(env.GATE_PREV_RUNS || "[]");
  } catch {
    /* unreadable history: engineGate fails open */
  }
  const result = engineGate({
    event: env.GATE_EVENT,
    runAttempt: env.GATE_RUN_ATTEMPT,
    engineAttempt: env.GATE_ENGINE_ATTEMPT,
    artifactCount: env.GATE_ARTIFACT_COUNT,
    logText,
    previousRuns,
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `skip=${result.skip}\nreason=${result.reason}\n`);
  const line = result.skip ? `Engine nightly: not run (${result.reason})` : `Engine nightly: running (${result.reason})`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${line}\n`);
  console.log(`[gate] skip=${result.skip} ${result.reason}`);
}
