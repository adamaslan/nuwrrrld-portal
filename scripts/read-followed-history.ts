#!/usr/bin/env node
/** Local-only reconstruction consumer. Never fetches prices or connects to a DB.
 * Run with: npx tsx scripts/read-followed-history.ts --help
 * Anchors come from a separately verified run receipt, not from the input JSON.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildHistoricalScoreboard } from "../lib/shared/followed-historical-scoreboard";

async function main() {
  const { values: v } = parseArgs({ options: {
    artifact: { type: "string" }, sha256: { type: "string" }, "run-id": { type: "string" },
    "engine-sha256": { type: "string" }, "universe-sha256": { type: "string" },
    today: { type: "string" }, "year-end-sessions": { type: "string" }, help: { type: "boolean" },
  }, strict: true });
  if (v.help) {
    console.log("Read a pinned frozen-cohort reconstruction locally. No network, DB, or writes.\nRequired: --artifact FILE --sha256 HASH --run-id ID --engine-sha256 HASH --universe-sha256 HASH --today YYYY-MM-DD\nOptional: --year-end-sessions FILE (independently verified year-to-final-exchange-session JSON map, required for YTD outcomes).\nWrites the labelled scoreboard JSON to stdout. Pooled detector manifests are not compatible.");
    return;
  }
  for (const name of ["artifact", "sha256", "run-id", "engine-sha256", "universe-sha256", "today"] as const)
    if (!v[name]) throw Error(`missing --${name}`);
  if (!/^[a-f0-9]{64}$/.test(v.sha256!)) throw Error("invalid expected artifact hash");
  const raw = await readFile(v.artifact!);
  if (createHash("sha256").update(raw).digest("hex") !== v.sha256) throw Error("artifact digest mismatch");
  let yearEndSessions: Record<string, string> | undefined;
  if (v["year-end-sessions"]) {
    const value: unknown = JSON.parse(await readFile(v["year-end-sessions"], "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.entries(value).every(([year, day]) => /^\d{4}$/.test(year) && typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)))
      throw Error("invalid year-end session map");
    yearEndSessions = value as Record<string, string>;
  }
  const result = buildHistoricalScoreboard(JSON.parse(raw.toString("utf8")), {
    runId: v["run-id"]!, engineSha256: v["engine-sha256"]!, universeSha256: v["universe-sha256"]!,
    today: v.today!, yearEndSessions,
  });
  if (result.status === "invalid") throw Error(result.reason);
  console.log(JSON.stringify({ artifactSha256: v.sha256, ...result.view }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "historical artifact unreadable"); process.exitCode = 1; });
