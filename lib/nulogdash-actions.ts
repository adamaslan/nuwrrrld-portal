"use server";

/**
 * nulogdash-actions — the only write path the nulogdash console has
 * (docs/admin-console-todo.md §2 / §5). Two Server Actions:
 *
 *   triggerPipelineRun      — always a dry run. Returns a confirm token.
 *   confirmLivePipelineRun  — always a live run. Requires that token + the
 *                             typed-back pipeline name + a non-prod DB + rate
 *                             headroom.
 *
 * There is deliberately no `dryRun` boolean the client can flip: the client
 * cannot request a live run in a single call. Every check below re-derives
 * identity and permission from the session — nothing the client sends about
 * who it is or what it may do is trusted (§5.2).
 */
import { auth, currentUser } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { canPerformAdminAction, primaryEmail } from "@/lib/nulogdash";
import { rateLimit } from "@/lib/rate-limit";
import { assertNotProductionDb, ProductionDbWriteError } from "@/lib/pipeline-db-guard";
import {
  PIPELINE_ROUTE,
  isTriggerablePipeline,
  mintConfirmToken,
  consumeConfirmToken,
  type TriggerablePipeline,
  type TriggerResult,
} from "@/lib/nulogdash-trigger";

const LIVE_RUNS_PER_WINDOW = 1;
const LIVE_WINDOW_MS = 5 * 60_000;
const PIPELINE_TIMEOUT_MS = 600_000;

/** auth() → currentUser() → canPerformAdminAction (MFA-gated, NOT
 * isNulogdashAdmin). Throws on any failure so the action rejects. */
async function requireAdmin(): Promise<{ userId: string; email: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated.");
  const user = await currentUser();
  if (!canPerformAdminAction(user)) {
    throw new Error(
      "This action needs an allowlisted admin account with two-factor authentication enabled.",
    );
  }
  return { userId, email: primaryEmail(user) };
}

/** Own origin, for a loopback call to the pipeline route. The bearer secret is
 * attached server-side and never crosses to the client (§5.1). */
async function selfOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  return `${proto}://${host}`;
}

async function callPipelineRoute(
  pipeline: TriggerablePipeline,
  dryRun: boolean,
  session: string,
): Promise<{ status: number; ok: boolean; bodyText: string }> {
  const { path, secretEnv } = PIPELINE_ROUTE[pipeline];
  const secret = process.env[secretEnv];
  if (!secret) throw new Error(`${secretEnv} is not configured on the server.`);

  const res = await fetch(`${await selfOrigin()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ dry_run: dryRun, session }),
    signal: AbortSignal.timeout(PIPELINE_TIMEOUT_MS),
  });
  return { status: res.status, ok: res.ok, bodyText: (await res.text()).slice(0, 2000) };
}

/**
 * Fire a **dry run** of `pipeline` and, on success, mint a single-use token the
 * caller can present to `confirmLivePipelineRun` to promote it to a live run.
 */
export async function triggerPipelineRun(raw: { pipeline: string }): Promise<TriggerResult> {
  const { userId, email } = await requireAdmin();

  const pipeline = raw?.pipeline;
  if (!isTriggerablePipeline(pipeline)) {
    return { ok: false, dryRun: true, pipeline: String(pipeline ?? ""), error: "Unknown pipeline." };
  }

  try {
    const { status, ok, bodyText } = await callPipelineRoute(pipeline, true, `nulogdash:${email}`);
    if (!ok) {
      return {
        ok: false,
        dryRun: true,
        pipeline,
        status,
        error: `Pipeline route returned ${status}: ${bodyText}`,
      };
    }
    revalidatePath("/dashboard/nulogdash/pipelines");
    return {
      ok: true,
      dryRun: true,
      pipeline,
      status,
      confirmToken: mintConfirmToken(pipeline, userId),
    };
  } catch (err) {
    return {
      ok: false,
      dryRun: true,
      pipeline,
      error: err instanceof Error ? err.message : "Dry run failed.",
    };
  }
}

/**
 * Fire a **live run** of `pipeline`. All of these must hold:
 *   - the caller is an MFA'd allowlisted admin (re-checked here);
 *   - `typedName` exactly equals `pipeline` (§5.4 friction);
 *   - `confirmToken` is the unexpired token from a prior `triggerPipelineRun`
 *     for this exact {pipeline, user} — it is burned on use;
 *   - `DATABASE_URL` does not resolve to `PRODUCTION_DB_HOST` (§5.7);
 *   - the per-user rate limit for this pipeline has headroom (§5.5).
 */
export async function confirmLivePipelineRun(raw: {
  pipeline: string;
  confirmToken: string;
  typedName: string;
}): Promise<TriggerResult> {
  const { userId, email } = await requireAdmin();

  const pipeline = raw?.pipeline;
  if (!isTriggerablePipeline(pipeline)) {
    return { ok: false, dryRun: false, pipeline: String(pipeline ?? ""), error: "Unknown pipeline." };
  }

  if (raw?.typedName !== pipeline) {
    return { ok: false, dryRun: false, pipeline, error: "Typed pipeline name does not match." };
  }

  if (!raw?.confirmToken || !consumeConfirmToken(pipeline, userId, raw.confirmToken)) {
    return {
      ok: false,
      dryRun: false,
      pipeline,
      error:
        "Confirmation expired or invalid. Run a dry run first, then confirm the live run within 2 minutes.",
    };
  }

  try {
    assertNotProductionDb("nulogdash live pipeline trigger");
  } catch (err) {
    if (err instanceof ProductionDbWriteError) {
      return { ok: false, dryRun: false, pipeline, error: err.message };
    }
    throw err;
  }

  const rl = rateLimit(`pipeline-live:${userId}:${pipeline}`, LIVE_RUNS_PER_WINDOW, LIVE_WINDOW_MS);
  if (!rl.ok) {
    const mins = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 60_000));
    return {
      ok: false,
      dryRun: false,
      pipeline,
      error: `Rate limit: one live run per pipeline per 5 minutes. Try again in ~${mins} min.`,
    };
  }

  try {
    const { status, ok, bodyText } = await callPipelineRoute(pipeline, false, `nulogdash:${email}`);
    if (!ok) {
      return {
        ok: false,
        dryRun: false,
        pipeline,
        status,
        error: `Pipeline route returned ${status}: ${bodyText}`,
      };
    }
    revalidatePath("/dashboard/nulogdash/pipelines");
    return { ok: true, dryRun: false, pipeline, status };
  } catch (err) {
    return {
      ok: false,
      dryRun: false,
      pipeline,
      error: err instanceof Error ? err.message : "Live run failed.",
    };
  }
}
