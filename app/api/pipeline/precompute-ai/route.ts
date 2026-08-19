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
import { fetchWithModelFallbackChecked } from "@/lib/openrouter";
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
import { resolveHorizon, resolveUniverseScope } from "@/lib/shared/universe-policy";
import { gradeFromScore, type PortfolioHealth } from "@/lib/portfolio";

export const maxDuration = 300;

const MCP_URL = process.env.MCP_BACKEND_URL;

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

export async function POST(req: NextRequest) {
  const secret = process.env.PORTAL_PUSH_SECRET;
  if (!secret) {
    console.error(
      "[precompute-ai] CONFIG_ERROR: PORTAL_PUSH_SECRET is not set — this endpoint " +
        "rejects all requests until it is configured (Vercel project env vars).",
    );
    return NextResponse.json({ error: "PORTAL_PUSH_SECRET not configured" }, { status: 503 });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
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
  };
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
    const cards = await topCards(horizon, maxSubjects * THESIS_BATCH_SIZE, scope);
    subjects = batchThesisSubjects(cards.map((c) => c.ticker));
    selection = `ranking:${scope}:${horizon}`;
  } else {
    subjects = await listWatchlistSubjects(maxSubjects);
    selection = "watchlist";
  }

  if (subjects.length === 0) {
    return NextResponse.json({
      ok: true,
      generated: 0,
      results: [],
      selection,
      note: source === "ranking" ? "no ranked cards available" : "no watchlist subjects",
    });
  }

  const results: PrecomputeResult[] = [];
  let quotaExhausted = false;

  for (const subject of subjects.slice(0, maxSubjects)) {
    const tickers = subject.split(",").filter(Boolean);
    const health = await fetchHealth(tickers);
    const prompt = buildHealthPrompt(tickers, health);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
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
      if (!narrative.trim()) {
        results.push({ subject, ok: false, reason: "empty completion" });
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
      results.push({ subject, ok: saved, model, reason: saved ? undefined : "db write failed" });
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
  console.info(
    `[precompute-ai] selection=${selection} generated=${generated}/${results.length} ` +
      `quotaExhausted=${quotaExhausted}`,
  );

  return NextResponse.json({
    ok: true,
    // Which pool the subjects came from. Without it, a run that silently fell
    // back to the watchlist because the ranking was empty is indistinguishable
    // from one that read the ranking and found those tickers on top.
    selection,
    generated,
    attempted: results.length,
    quotaExhausted,
    results,
  });
}
