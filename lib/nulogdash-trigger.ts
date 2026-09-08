/**
 * nulogdash-trigger — pure helpers behind the nulogdash pipeline trigger
 * buttons (docs/admin-console-todo.md §2 / §5). The Server Actions live in
 * lib/nulogdash-actions.ts; everything that does not need `"use server"` lives
 * here so it can be unit-tested and imported by client components (types only).
 *
 * Safety property this file exists to support (§5): the browser must never be
 * able to do something `scripts/local-trigger.mjs` would have refused. The CLI
 * defaults to a dry run and needs `--no-dry-run --yes` for a live one; the
 * two-call token dance below is the browser equivalent of `--yes`.
 */
import { randomUUID } from "node:crypto";

/** The three model-spending pipelines, matching `PipelineName` in
 * lib/pipeline-run-log-db.ts. */
export const TRIGGERABLE_PIPELINES = [
  "followed-tickers",
  "followed-tickers-judge",
  "precompute-ai",
] as const;

export type TriggerablePipeline = (typeof TRIGGERABLE_PIPELINES)[number];

/** Route + auth-secret env var per pipeline. Mirrors scripts/local-trigger.mjs
 * and docs/local-pipeline-runs-and-html-reports.md §0 — followed-tickers* auth
 * with CRON_SECRET, precompute-ai with PORTAL_PUSH_SECRET. */
export const PIPELINE_ROUTE: Record<
  TriggerablePipeline,
  { path: string; secretEnv: "CRON_SECRET" | "PORTAL_PUSH_SECRET" }
> = {
  "followed-tickers": { path: "/api/pipeline/followed-tickers", secretEnv: "CRON_SECRET" },
  "followed-tickers-judge": {
    path: "/api/pipeline/followed-tickers-judge",
    secretEnv: "CRON_SECRET",
  },
  "precompute-ai": { path: "/api/pipeline/precompute-ai", secretEnv: "PORTAL_PUSH_SECRET" },
};

export function isTriggerablePipeline(v: unknown): v is TriggerablePipeline {
  return typeof v === "string" && (TRIGGERABLE_PIPELINES as readonly string[]).includes(v);
}

/** Shape returned by both trigger actions. */
export interface TriggerResult {
  ok: boolean;
  /** false only for a completed live run. */
  dryRun: boolean;
  pipeline: string;
  /** HTTP status from the pipeline route, when one was reached. */
  status?: number;
  /** Present on `ok: false`. */
  error?: string;
  /** Present on a successful dry run: pass it (with the typed-back name) to
   * `confirmLivePipelineRun` within the TTL to promote it to a live run. */
  confirmToken?: string;
}

// ── live-run confirmation tokens (§5.4) ─────────────────────────────────────
// Single-use, short-TTL, keyed to {pipeline, userId}. In-process only — the
// same best-effort-on-serverless caveat as lib/rate-limit.ts. Its job is to
// force a deliberate second server round trip, not to be a distributed lock.

export const CONFIRM_TTL_MS = 2 * 60_000;

interface PendingConfirm {
  token: string;
  expiresAt: number;
}

const pendingConfirms = new Map<string, PendingConfirm>();

const key = (pipeline: string, userId: string) => `${pipeline}::${userId}`;

/** Mint (and store) a fresh single-use confirm token for this pipeline+user. */
export function mintConfirmToken(pipeline: string, userId: string, now = Date.now()): string {
  const token = randomUUID();
  pendingConfirms.set(key(pipeline, userId), { token, expiresAt: now + CONFIRM_TTL_MS });
  return token;
}

/** Validate and burn a confirm token. Returns true only for an unexpired exact
 * match; the token is deleted whether or not it matched (single use). */
export function consumeConfirmToken(
  pipeline: string,
  userId: string,
  token: string,
  now = Date.now(),
): boolean {
  const k = key(pipeline, userId);
  const rec = pendingConfirms.get(k);
  pendingConfirms.delete(k);
  if (!rec) return false;
  if (rec.expiresAt < now) return false;
  return rec.token === token && token.length > 0;
}

/** Test-only: drop all pending confirmations. */
export function __resetConfirmTokens(): void {
  pendingConfirms.clear();
}
