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
 *   GATE_ARTIFACT_COUNT  hydrate-log artifacts on the triggering run
 *   GATE_LOG_PATH        downloaded hydrate.log (may be missing)
 *   GATE_PREV_STATUS     previous engine-nightly run's status ("" if none)
 *   GATE_PREV_CONCLUSION previous engine-nightly run's conclusion
 * Writes skip=true|false and reason=… to GITHUB_OUTPUT and one summary line.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The single `[done]` line's key=value fields, or null when there is not exactly one. */
export function parseDoneLine(logText) {
  const lines = String(logText ?? "").split(/\r?\n/).filter((l) => l.startsWith("[done]"));
  if (lines.length !== 1) return null;
  const fields = {};
  for (const token of lines[0].slice("[done]".length).trim().split(/\s+/)) {
    const m = /^([a-z-]+)=(\S+)$/.exec(token);
    if (!m || m[1] in fields) return null;
    fields[m[1]] = m[2];
  }
  return fields;
}

/**
 * @param {{ event?: string, runAttempt?: string, artifactCount?: string, logText?: string | null,
 *           previousEngine?: { status?: string, conclusion?: string } | null }} input
 * @returns {{ skip: boolean, reason: string }}
 */
export function engineGate({ event, runAttempt, artifactCount, logText, previousEngine }) {
  const run = (reason) => ({ skip: false, reason });
  if (event !== "workflow_run") return run(`trigger is ${event || "unknown"}, not workflow_run`);
  // A re-run attempt can leave the artifact from another attempt; only the first is unambiguous.
  if (runAttempt !== "1") return run(`triggering hydration attempt is ${runAttempt || "unknown"}, not 1`);
  if (artifactCount !== "1") return run(`found ${artifactCount || "no"} hydrate-log artifacts, need exactly 1`);
  // A failed or cancelled engine run must get its next chance to recompute.
  if (!previousEngine || previousEngine.status !== "completed" || previousEngine.conclusion !== "success") {
    return run(`previous engine run is ${previousEngine?.status || "missing"}/${previousEngine?.conclusion || "none"}, not completed/success`);
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
  const result = engineGate({
    event: env.GATE_EVENT,
    runAttempt: env.GATE_RUN_ATTEMPT,
    artifactCount: env.GATE_ARTIFACT_COUNT,
    logText,
    previousEngine: env.GATE_PREV_STATUS ? { status: env.GATE_PREV_STATUS, conclusion: env.GATE_PREV_CONCLUSION } : null,
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `skip=${result.skip}\nreason=${result.reason}\n`);
  const line = result.skip ? `Engine nightly: not run (${result.reason})` : `Engine nightly: running (${result.reason})`;
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${line}\n`);
  console.log(`[gate] skip=${result.skip} ${result.reason}`);
}
