/**
 * POST /api/pipeline/precompute-ai
 *
 * Option D of docs/gha-modal-core-feature-coverage.md. Generates the batch AI
 * artifacts that do NOT need a user present, and stores them in
 * `precomputed_ai` for routes to serve as ordinary cached reads.
 *
 * Why this endpoint exists at all: OpenRouter's free tier caps the whole API
 * key at 50 requests/day, resetting at UTC midnight. Today, batch AI work and
 * interactive Nu AI chat compete for that one bucket, and batch usually wins
 * by running first. Called by a scheduled job just after the reset, this route
 * spends quota when it is cheapest and leaves the rest of the day's allowance
 * for calls a user is actually waiting on.
 *
 * Auth: Bearer PORTAL_PUSH_SECRET — server-to-server, same contract as
 * /api/signals/refresh and /api/signals/drain. Never user-facing.
 *
 * Deliberately bounded: `maxSubjects` caps how many artifacts one invocation
 * will generate, and the route stops early once the model chain reports the
 * daily quota is gone. A precompute job that burns the entire allowance is
 * strictly worse than no job, because it starves the interactive path it was
 * meant to protect.
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { fetchWithModelFallbackChecked, FREE_MODEL_CHAIN } from "@/lib/openrouter";
import { logPipelineRun, type RunItem } from "@/lib/pipeline-run-log-db";
import {
  listWatchlistSubjects,
  savePrecomputed,
  subjectFromTickers,
} from "@/lib/precomputed-ai-db";
import {
  THESIS_BATCH_SIZE,
  batchThesisSubjects,
  resolvePrecomputeSource,
} from "@/lib/shared/precompute-policy";
import { topCards } from "@/lib/ticker-cards-db";
import {
  resolveHorizon,
  resolveLimit,
  resolveUniverseScope,
} from "@/lib/shared/universe-policy";
import { gradeFromScore, type PortfolioHealth } from "@/lib/portfolio";

export const maxDuration = 300;

const MCP_URL = process.env.MCP_BACKEND_URL;

/** Per-subject wall-clock ceiling for the model call + stream drain. Was an
 *  inline `60_000` — too tight for the slower reasoning models at the head of
 *  FREE_MODEL_CHAIN, which routinely need ~50s just to emit content, so a run
 *  would abort every subject and still report HTTP 200. Widened, and the loop
 *  now stops before it would exceed `maxDuration` rather than being killed
 *  mid-subject by the platform. */
const PER_SUBJECT_TIMEOUT_MS = 110_000;

/** Leave this much of `maxDuration` unspent for fetchHealth + the DB write +
 *  the run-log write that follow the model call. */
const TAIL_BUDGET_MS = 25_000;

/** Classify why a run produced nothing, so a caller (Modal, the GHA step, the
 *  run log) can tell "quota gone" from "models too slow" from "bad key" without
 *  string-matching a prose error. */
function classifyFailure(
  results: PrecomputeResult[],
  quotaExhausted: boolean,
): "quota" | "timeout" | "empty" | "auth" | "error" | null {
  if (results.length === 0) return null;
  if (quotaExhausted) return "quota";
  const reasons = results.map((r) => r.reason ?? "");
  if (reasons.every((r) => r === "empty completion")) return "empty";
  if (reasons.some((r) => /abort/i.test(r))) return "timeout";
  if (reasons.some((r) => /OpenRouter (401|403)/.test(r))) return "auth";
  return "error";
}

/** Hard ceiling per invocation, independent of the caller's request, so a
 *  misconfigured schedule can't drain the day's quota in one run. */
const MAX_SUBJECTS_CEILING = 25;
const DEFAULT_MAX_SUBJECTS = 10;

/** Artifacts stay servable for a day; the next scheduled run replaces them. */
const ARTIFACT_TTL_HOURS = 26;

interface PrecomputeResult {
  subject: string;
  ok: boolean;
  model?: string;
  reason?: string;
  /** Wall-clock ms for the model call + stream drain, when one was attempted. */
  latencyMs?: number;
  /** True when the serving model was not the head of FREE_MODEL_CHAIN. */
  fallback?: boolean;
}

/** Same stateless ticker-keyed call the interactive health route makes. */
async function fetchHealth(tickers: string[]): Promise<PortfolioHealth | null> {
  if (!MCP_URL || tickers.length === 0) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      `${MCP_URL}/api/portfolio/health?tickers=${encodeURIComponent(tickers.join(","))}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const raw = (await res.json()) as Record<string, unknown>;
    const score = typeof raw.score === "number" ? Math.round(raw.score) : 0;
    return {
      score,
      grade: gradeFromScore(score),
      factors: Array.isArray(raw.factors) ? (raw.factors as PortfolioHealth["factors"]) : [],
      summary: typeof raw.summary === "string" ? raw.summary : "",
      generatedAt:
        typeof raw.generated_at === "string" ? raw.generated_at : new Date().toISOString(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildHealthPrompt(tickers: string[], health: PortfolioHealth | null): string {
  const lines = [
    "=== REAL PORTFOLIO DATA ===",
    `Watchlist tickers: ${tickers.length > 0 ? tickers.join(", ") : "none added yet"}`,
  ];
  if (health) {
    lines.push(
      `Portfolio health score: ${health.score}/100 (Grade ${health.grade})`,
      `Health summary: ${health.summary}`,
    );
    if (health.factors.length > 0) {
      lines.push(
        "Factor breakdown:",
        ...health.factors.map(
          (f) => `  - ${f.name}: ${f.score}/100 (${f.impact}) — ${f.description}`,
        ),
      );
    }
  } else {
    lines.push("Portfolio health data: unavailable (no GCP3 backend connection)");
  }
  lines.push(
    "",
    "Using ONLY the exact data above, provide a portfolio health check.",
    "Deliver: 1) Overall assessment (A–F grade with explanation) 2) Biggest risk factor 3) One specific, grounded rebalancing suggestion based on the actual tickers and factors shown.",
    "Be concise (~180 words). Cite specific numbers. This is informational only, not personalised financial advice.",
  );
  return lines.join("\n");
}

/** Buffers a streamed completion to text — the precompute path has no client
 *  to stream to, so it stores the finished narrative. */
async function collectCompletion(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        text += parsed.choices?.[0]?.delta?.content ?? "";
      } catch {
        /* skip malformed frame — production readers do the same */
      }
    }
  }
  return text;
}

/** True when the error indicates the account's daily free allowance is gone —
 *  the one condition where continuing is actively harmful rather than futile. */
function isQuotaExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /OpenRouter 429/.test(msg);
}

/**
 * Cron entrypoint for the AI narrative precompute. Bearer-authed. Selects a
 * batch of watchlist subjects, generates a narrative per subject through the
 * OpenRouter model-fallback chain, and saves the results. Emits a model-usage
 * audit row (docs/model-usage/) recording the exact model id that produced
 * each narrative; `fallback` is left unset because the checked fetch helper
 * does not report which chain position served.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    console.error(
      "[precompute-ai] CONFIG_ERROR: PORTAL_PUSH_SECRET is not set — this endpoint " +
        "rejects all requests until it is configured (Vercel project env vars).",
    );
    return NextResponse.json({ error: "PORTAL_PUSH_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as {
    maxSubjects?: number;
    subjects?: string[];
    source?: string;
    universe?: string;
    horizon?: string;
    dry_run?: boolean;
    session?: string;
  };
  const dryRun = body.dry_run === true;
  // Optional caller label for run-log attribution (docs/admin-console-todo.md
  // §5.6). Scheduled callers omit it; the nulogdash trigger action sends
  // "nulogdash:<admin email>".
  const session = typeof body.session === "string" ? body.session : null;
  const maxSubjects = Math.min(
    MAX_SUBJECTS_CEILING,
    Math.max(1, Number(body.maxSubjects) || DEFAULT_MAX_SUBJECTS),
  );
  const source = resolvePrecomputeSource(body.source);

  // Three ways to choose subjects, in precedence order:
  //   explicit list  — testable against a known portfolio, independent of
  //                    whatever happens to be in the watchlist table
  //   ranking        — supply-side: the strongest cards in the universe,
  //                    batched so ten tickers cost one request, not ten
  //   watchlist      — demand-side, the original default: what users hold
  let subjects: string[];
  let selection: string;
  if (body.subjects?.length) {
    subjects = body.subjects.map((s) => subjectFromTickers(s.split(",")));
    selection = "explicit";
  } else if (source === "ranking") {
    const scope = resolveUniverseScope(body.universe);
    const horizon = resolveHorizon(body.horizon);
    // Pull enough cards to fill `maxSubjects` batches, no more: over-fetching
    // here would rank tickers the run has no quota left to narrate anyway.
    // Through resolveLimit so this path obeys the same MAX_TOP_LIMIT the HTTP
    // route does — at the MAX_SUBJECTS_CEILING of 25 the naive product is 250,
    // which would otherwise reach SQL as a raw LIMIT and quietly exceed a
    // bound the rest of the system treats as fixed.
    const wanted = resolveLimit(maxSubjects * THESIS_BATCH_SIZE);
    const cards = await topCards(horizon, wanted, scope);
    subjects = batchThesisSubjects(cards.map((c) => c.ticker));
    selection = `ranking:${scope}:${horizon}`;
  } else {
    subjects = await listWatchlistSubjects(maxSubjects);
    selection = "watchlist";
  }

  if (subjects.length === 0) {
    // Still an invocation — log a zero-item row so "one row per run" holds.
    const runLogged = await logPipelineRun({
      pipeline: "precompute-ai",
      dryRun,
      session,
      itemsTotal: 0,
      items: [],
      summary: {
        selection,
        generated: 0,
        attempted: 0,
        note: source === "ranking" ? "no ranked cards" : "no watchlist subjects",
      },
    });
    return NextResponse.json({
      ok: true,
      dryRun,
      generated: 0,
      results: [],
      selection,
      note: source === "ranking" ? "no ranked cards available" : "no watchlist subjects",
      runLogged,
    });
  }

  // A dry run rehearses subject selection only — no model call, no quota
  // spend, no DB write. It exists so the manual-trigger path (see
  // scripts/local-trigger.mjs) can be run by default without --yes, the same
  // way the other two pipelines' dry runs work.
  if (dryRun) {
    const rehearsed = subjects.slice(0, maxSubjects);
    const runItems: RunItem[] = rehearsed.map((subject) => ({
      subject,
      model: null,
      outcome: "skip",
    }));
    const runLogged = await logPipelineRun({
      pipeline: "precompute-ai",
      dryRun: true,
      session,
      itemsTotal: subjects.length,
      items: runItems,
      summary: { selection, wouldAttempt: rehearsed.length },
    });
    return NextResponse.json({
      ok: true,
      dryRun: true,
      selection,
      wouldAttempt: rehearsed.length,
      subjects: rehearsed,
      runLogged,
    });
  }

  const results: PrecomputeResult[] = [];
  let quotaExhausted = false;
  let budgetStopped = false;
  const runStartedAt = Date.now();
  const wallClockBudgetMs = maxDuration * 1000 - TAIL_BUDGET_MS;

  for (const subject of subjects.slice(0, maxSubjects)) {
    // Stop before a subject that couldn't finish inside the route's own
    // maxDuration — a platform kill mid-subject loses the results already in
    // hand and never writes the run-log row.
    if (Date.now() - runStartedAt + PER_SUBJECT_TIMEOUT_MS > wallClockBudgetMs) {
      budgetStopped = true;
      console.warn(
        `[precompute-ai] stopping after ${results.length} subject(s) — not enough ` +
          `wall-clock budget left for another ${PER_SUBJECT_TIMEOUT_MS}ms attempt`,
      );
      break;
    }

    const tickers = subject.split(",").filter(Boolean);
    const health = await fetchHealth(tickers);
    const prompt = buildHealthPrompt(tickers, health);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PER_SUBJECT_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
      const { response, model } = await fetchWithModelFallbackChecked(
        apiKey,
        {
          max_tokens: 1024,
          stream: true,
          temperature: 0.3,
          messages: [{ role: "user", content: prompt }],
        },
        // ASCII only: this becomes the X-Title HTTP header, and a non-Latin-1
        // character makes fetch() throw before the request is sent. The em-dash
        // that used to live here failed every model in the chain silently.
        "NuWrrrld Precompute - Portfolio Health",
        ctrl.signal,
      );
      const narrative = await collectCompletion(response.body!);
      const latencyMs = Date.now() - startedAt;
      // The checked helper returns only the winning id, not its chain position,
      // so derive "did the chain have to rescue this" from the id itself.
      const fallback = FREE_MODEL_CHAIN.indexOf(model as (typeof FREE_MODEL_CHAIN)[number]) > 0;
      if (!narrative.trim()) {
        results.push({ subject, ok: false, reason: "empty completion", model, latencyMs, fallback });
        continue;
      }

      const expiresAt = new Date(Date.now() + ARTIFACT_TTL_HOURS * 3_600_000);
      const saved = await savePrecomputed(
        "portfolio_health_ai",
        subject,
        {
          narrative,
          // Stored alongside so a consumer can show the score the narrative was
          // actually written against, rather than pairing old prose with a
          // freshly-fetched score that may disagree with it.
          health,
          grounded: health !== null,
          tickers,
        },
        model,
        expiresAt,
      );
      results.push({
        subject,
        ok: saved,
        model,
        latencyMs,
        fallback,
        reason: saved ? undefined : "db write failed",
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({ subject, ok: false, reason });
      if (isQuotaExhausted(err)) {
        // Stop immediately. Continuing would spend retries against an
        // allowance that is already gone, and every one of those failures
        // still counts toward the rate limiter.
        quotaExhausted = true;
        console.warn(
          `[precompute-ai] daily quota exhausted after ${results.length} subject(s) — stopping early`,
        );
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  const generated = results.filter((r) => r.ok).length;
  // A run that attempted subjects and generated none is a failure, not a
  // no-op — returning a clean 200 here made a dead nightly job indistinguishable
  // from a healthy one to any caller that only checks the HTTP status
  // (deploy/precompute-ai/modal_app.py's `raise_for_status()`).
  const totalFailure = results.length > 0 && generated === 0;
  const failureMode = totalFailure ? classifyFailure(results, quotaExhausted) : null;
  console.info(
    `[precompute-ai] selection=${selection} generated=${generated}/${results.length} ` +
      `quotaExhausted=${quotaExhausted} budgetStopped=${budgetStopped} ` +
      `failureMode=${failureMode ?? "none"}`,
  );

  // Model-usage audit row (docs/model-usage/). `fallback` is derived from the
  // served id's position in FREE_MODEL_CHAIN (the checked helper doesn't report
  // it directly); `latencyMs` covers the model call plus the stream drain.
  const runItems: RunItem[] = results.map((r) => ({
    subject: r.subject,
    model: r.model ?? null,
    outcome: r.ok ? "ok" : r.reason === "empty completion" ? "empty" : "fail",
    latencyMs: r.latencyMs,
    fallback: r.fallback,
  }));
  const runLogged = await logPipelineRun({
    pipeline: "precompute-ai",
    dryRun: false,
    session,
    itemsTotal: subjects.length,
    items: runItems,
    summary: {
      selection,
      generated,
      attempted: results.length,
      quotaExhausted,
      budgetStopped,
      failureMode,
    },
  });

  return NextResponse.json(
    {
      ok: !totalFailure,
      dryRun: false,
      // Which pool the subjects came from. Without it, a run that silently fell
      // back to the watchlist because the ranking was empty is indistinguishable
      // from one that read the ranking and found those tickers on top.
      selection,
      generated,
      attempted: results.length,
      quotaExhausted,
      // True when the loop stopped early to stay inside maxDuration rather than
      // being killed mid-subject — the run is partial, not failed.
      budgetStopped,
      // null on success; otherwise "quota" | "timeout" | "empty" | "auth" | "error".
      failureMode,
      results,
      runLogged,
    },
    // 502 so a status-only caller (Modal's raise_for_status) also sees the
    // failure; the GHA step already caught this via a jq check on the body.
    { status: totalFailure ? 502 : 200 },
  );
}
