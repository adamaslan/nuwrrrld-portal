import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { NulogdashRun } from "./nulogdash";

const text = z.string().min(1).max(2048);
const strings = z.array(z.string().max(4096)).max(1000);
const reportSchema = z.object({
  runId: text, runAt: z.string().datetime({ offset: true }),
  gitSha: text, branch: text, baseUrl: z.string().url(), tiers: strings,
  results: z.array(z.object({
    feature: text, label: text, entrypoints: strings,
    tier: z.enum(["api", "browser"]).nullable(), dependencies: strings,
    latencyMs: z.number().finite().nonnegative().nullable(),
    status: z.enum(["pass", "fail", "blocked", "not_run"]),
    reason: z.string().max(32768).nullable(),
  })).max(10000),
  excluded: z.array(z.object({ feature: text, path: text, reason: text })).max(10000),
  driftWarnings: strings,
}).superRefine((run, ctx) => {
  const keys = run.results.map(row => `${row.tier}:${row.feature}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate result identity" });
});

export type ReportState =
  | { status: "ready"; run: NulogdashRun }
  | { status: "missing" }
  | { status: "unavailable"; reason: "invalid" | "oversized" | "read_failed" };
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** Read-only, bounded local sink. Never confuse unreadable evidence with no run. */
export function loadLatestReport(path = join(process.cwd(), ".nulogdash", "latest.json")): ReportState {
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) return { status: "unavailable", reason: "oversized" };
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) return { status: "unavailable", reason: "oversized" };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { status: "unavailable", reason: "invalid" }; }
    const result = reportSchema.safeParse(parsed);
    if (!result.success) return { status: "unavailable", reason: "invalid" };
    return { status: "ready", run: result.data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unavailable", reason: "read_failed" };
  }
}
