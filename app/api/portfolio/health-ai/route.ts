import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement } from "@/lib/subscription";
import { resolveTier } from "@/lib/subscription-admin";
import type { SubscriptionStatus } from "@/lib/subscription";
import { getWatchlist } from "@/lib/watchlist-store";
import type { PortfolioHealth } from "@/lib/portfolio";
import { gradeFromScore } from "@/lib/portfolio";
import { fetchWithModelFallbackChecked, MODEL_CHAIN_WALK_BUDGET_MS, readChunkWithIdleTimeout } from "@/lib/openrouter";
import { getPrecomputed, subjectFromTickers } from "@/lib/precomputed-ai-db";
import { localPortfolioHealth } from "@/lib/portfolio-health-local";
import { NU_AI_DAILY_TOKEN_BUDGET, reservationExceedsBudget } from "@/lib/nuai";
import { getUsedTokensToday, addTokenUsage, reserveTokens, releaseTokens } from "@/lib/nuai-db";

const MCP_URL = process.env.MCP_BACKEND_URL;

// Stateless, ticker-keyed — mirrors app/api/portfolio/health/route.ts. No
// Clerk token is sent; gcp3's endpoint has no concept of "whose" portfolio
// this is, only "which tickers." See
// docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md.
async function fetchUpstreamHealth(tickers: string[]): Promise<PortfolioHealth | null> {
  if (!MCP_URL || tickers.length === 0) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7_000);
  try {
    const res = await fetch(
      `${MCP_URL}/api/portfolio/health?tickers=${encodeURIComponent(tickers.join(","))}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const raw = await res.json() as Record<string, unknown>;
    const score = typeof raw.score === "number" ? Math.round(raw.score) : 0;
    const grade = gradeFromScore(score);
    return {
      score,
      grade,
      factors: Array.isArray(raw.factors) ? raw.factors as PortfolioHealth["factors"] : [],
      summary: typeof raw.summary === "string" ? raw.summary : "",
      generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : new Date().toISOString(),
    };
  } catch { return null; } finally { clearTimeout(t); }
}

/**
 * Upstream first, then the local score computed from `ticker_cards` — exactly
 * the fallback `app/api/portfolio/health/route.ts` already applies. Before
 * this, a downed upstream (the only state gcp3's route has ever been in; its
 * OpenAPI still lists no `portfolio` path) meant the AI narrative degraded to
 * "no GCP3 backend connection" and narrated a portfolio it was handed no data
 * about. `localPortfolioHealth` has returned a real, factor-level score since
 * PR #123 — this was the one caller left not using it. See
 * docs/portfolio-health-todo.md §1.
 */
async function fetchHealth(tickers: string[]): Promise<PortfolioHealth | null> {
  return (await fetchUpstreamHealth(tickers)) ?? (await localPortfolioHealth(tickers));
}

// Same durable daily pool as /api/nuai (lib/nuai-db.ts's `nuai_usage` table,
// keyed by user+date, not by feature) — a health check and a chat turn draw
// from one budget, because they are the same underlying cost: a model call.
// Before this, health-ai was the one Pro-gated model-call path with no rate
// limit and no budget accounting at all (docs/portfolio-health-todo.md §7).
//
// The L1 cache below is a fast-path *optimization* only — it skips the
// upstream fetchHealth() call for a user this instance already knows is
// clearly over budget. It is never the authority on whether a request may
// proceed; `reserveAndCheckBudget` (called right before the model call,
// once the real prompt size is known) is, via an atomic DB round trip. Two
// concurrent requests both reading a stale/optimistic L1 value and both
// proceeding is exactly the race CodeRabbit flagged on PR #135 when the old
// getRemainingBudget()-then-proceed check was the only gate.
const L1_TTL_MS = 60_000;
const dailyUsageL1 = new Map<string, { tokens: number; expiresAt: number }>();

async function getCachedRemainingBudget(userId: string): Promise<number> {
  const now = Date.now();
  const cached = dailyUsageL1.get(userId);
  if (cached && cached.expiresAt > now) {
    return NU_AI_DAILY_TOKEN_BUDGET - cached.tokens;
  }
  const used = await getUsedTokensToday(userId);
  dailyUsageL1.set(userId, { tokens: used, expiresAt: now + L1_TTL_MS });
  return NU_AI_DAILY_TOKEN_BUDGET - used;
}

/**
 * The authoritative gate: atomically reserve `tokens` against today's budget
 * and report whether that reservation pushed the total over the cap. On
 * reject, the reservation is released so the request never counts against
 * quota. Updates the L1 cache either way so the next request's fast-path
 * pre-check stays close to the durable total.
 */
async function reserveAndCheckBudget(userId: string, tokens: number): Promise<{ allowed: boolean }> {
  const totalAfter = await reserveTokens(userId, tokens);
  const cached = dailyUsageL1.get(userId);
  if (reservationExceedsBudget(totalAfter, NU_AI_DAILY_TOKEN_BUDGET)) {
    await releaseTokens(userId, tokens);
    // totalAfter is non-null here (reservationExceedsBudget only rejects a
    // real total, never the fail-open null case) — cache it post-release.
    if (cached) cached.tokens = Math.max(cached.tokens, (totalAfter as number) - tokens);
    return { allowed: false };
  }
  if (cached) cached.tokens = totalAfter ?? cached.tokens + tokens;
  else if (totalAfter !== null) dailyUsageL1.set(userId, { tokens: totalAfter, expiresAt: Date.now() + L1_TTL_MS });
  return { allowed: true };
}

/** Adds the response-side tokens on top of what was already reserved for the
 *  prompt — `reserveAndCheckBudget` already accounted for the prompt itself. */
async function recordAdditionalUsage(userId: string, tokens: number) {
  if (tokens <= 0) return;
  const cached = dailyUsageL1.get(userId);
  if (cached) cached.tokens += tokens;
  await addTokenUsage(userId, tokens);
}

const RATE_LIMIT_MAX_PER_MINUTE = 12;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitWindows = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const rec = rateLimitWindows.get(userId);
  if (!rec || now - rec.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindows.set(userId, { count: 1, windowStart: now });
    return true;
  }
  if (rec.count >= RATE_LIMIT_MAX_PER_MINUTE) return false;
  rec.count += 1;
  return true;
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function buildHealthPrompt(
  watchlist: string[],
  health: PortfolioHealth | null,
): string {
  const lines = [
    `=== REAL PORTFOLIO DATA ===`,
    `Watchlist tickers: ${watchlist.length > 0 ? watchlist.join(", ") : "none added yet"}`,
  ];

  if (health) {
    lines.push(
      `Portfolio health score: ${health.score}/100 (Grade ${health.grade})`,
      `Health summary: ${health.summary}`,
    );
    if (health.factors.length > 0) {
      lines.push(
        `Factor breakdown:`,
        ...health.factors.map(f => `  - ${f.name}: ${f.score}/100 (${f.impact}) — ${f.description}`),
      );
    }
  } else {
    // Reached only when neither upstream nor the local ticker_cards fallback
    // produced a score — i.e. not one watchlist ticker has a computed signal.
    lines.push(`Portfolio health data: unavailable (no signals computed for this watchlist yet)`);
  }

  lines.push(
    ``,
    `Using ONLY the exact data above, provide a portfolio health check.`,
    `Deliver: 1) Overall assessment (A–F grade with explanation) 2) Biggest risk factor 3) One specific, grounded rebalancing suggestion based on the actual tickers and factors shown.`,
    `Be concise (~180 words). Cite specific numbers. This is informational only, not personalised financial advice.`,
  );

  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = resolveTier(status, user);

  if (!hasEntitlement("nu_ai", tier)) {
    return NextResponse.json({ error: "upgrade_required", upgradeUrl: "/pricing?source=portfolio" }, { status: 403 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 503 });

  const watchlist = await getWatchlist(userId).catch(() => []).then(list => list.map(i => i.ticker));

  // Precomputed-first (Option D, docs/gha-modal-core-feature-coverage.md): a
  // scheduled job generates this narrative just after OpenRouter's UTC-midnight
  // free-tier reset. Serving it here costs *zero* model quota, which is the
  // whole point — the 50/day allowance is then spent on interactive Nu AI chat
  // that genuinely cannot be precomputed, instead of on a batch narrative that
  // could have been produced hours earlier.
  //
  // Only the JSON path is served this way. A client that asked for SSE expects
  // a token stream, and faking one from stored text would add latency for no
  // benefit; those callers fall through to the live path below.
  const wantsStreamEarly = (req.headers.get("Accept") ?? "").includes("text/event-stream");
  if (!wantsStreamEarly) {
    const pre = await getPrecomputed<{
      narrative: string;
      grounded: boolean;
      health: PortfolioHealth | null;
    }>("portfolio_health_ai", subjectFromTickers(watchlist));
    if (pre?.payload?.narrative) {
      console.info(
        `[health-ai] served precomputed model=${pre.model} age=${pre.ageMinutes}m tickers=${watchlist.length}`,
      );
      return NextResponse.json({
        answer: pre.payload.narrative,
        grounded: pre.payload.grounded,
        // Age is surfaced rather than hidden so the UI can label this as "as of
        // {time}" instead of presenting hours-old commentary as current — the
        // honest-lesser rule in concept-graceful-degradation.md.
        precomputed: true,
        ageMinutes: pre.ageMinutes,
        generatedAt: pre.generatedAt,
      });
    }
  }

  // Precomputed responses above cost zero quota; only requests that reach the
  // live model call are metered, same split /api/nuai draws around its own
  // (non-existent) precomputed path.
  if (!checkRateLimit(userId)) {
    return NextResponse.json({ error: "rate_limit_exceeded" }, { status: 429 });
  }
  // Fast-path only — skips the upstream fetchHealth() call below for a user
  // this instance already knows is clearly over budget. Not authoritative;
  // see reserveAndCheckBudget below for the actual gate.
  if ((await getCachedRemainingBudget(userId)) <= 0) {
    return NextResponse.json({ error: "daily_limit_reached" }, { status: 429 });
  }

  const health = await fetchHealth(watchlist);
  const prompt = buildHealthPrompt(watchlist, health);
  const promptTokens = estimateTokens(prompt);
  // The authoritative gate: reserves promptTokens atomically before any
  // model call starts, so two concurrent requests can never both observe
  // "budget available" and both proceed (PR #135 CodeRabbit finding). Only
  // the prompt side is reserved up front — the response's token count isn't
  // known yet; recordAdditionalUsage below adds it once the call completes.
  const { allowed } = await reserveAndCheckBudget(userId, promptTokens);
  if (!allowed) {
    return NextResponse.json({ error: "daily_limit_reached" }, { status: 429 });
  }
  let tokenCount = promptTokens;
  // Surfaced to the client so an ungrounded narrative is shown as such rather
  // than silently — see docs/wiki-portal/concept-graceful-degradation.md
  // ("degrade to a lesser state, never to a plausible-looking fabrication").
  const grounded = health !== null;

  const ctrl = new AbortController();
  // Sized from the fallback chain, not hand-picked. A literal 25_000 here was
  // shorter than one full walk of primary + chain, so any request that had to
  // fall through was aborted mid-chain and returned 503 "AI unavailable" with
  // healthy models still untried. See MODEL_CHAIN_WALK_BUDGET_MS.
  const timer = setTimeout(() => ctrl.abort(), MODEL_CHAIN_WALK_BUDGET_MS);

  try {
    // Reasoning-capable models (nemotron-3-*) spend part of max_tokens on
    // hidden reasoning before any content token appears; 400 was tight enough
    // to starve that out entirely on some requests. 1024 matches /api/nuai.
    const { response, model } = await fetchWithModelFallbackChecked(
      apiKey,
      { max_tokens: 1024, stream: true, messages: [{ role: "user", content: prompt }], temperature: 0.3 },
      "NuWrrrld Financial Portfolio Health Check",
      ctrl.signal,
    );
    // Clear immediately: this timer bounds chain selection only. Left running
    // on the same AbortController, it stayed armed while the SSE body below
    // is read line by line — a slow-but-healthy model streaming past
    // MODEL_CHAIN_WALK_BUDGET_MS got aborted mid-read instead of finishing.
    clearTimeout(timer);
    console.info(`[health-ai] served model=${model} grounded=${grounded} tickers=${watchlist.length}`);

    const wantsStream = (req.headers.get("Accept") ?? "").includes("text/event-stream");
    const upstream = response.body!;
    const decoder = new TextDecoder();
    const reader = upstream.getReader();

    const drainSSELines = (raw: string, onDelta: (d: string) => void): { remaining: string; done: boolean } => {
      const lines = raw.split("\n");
      const remaining = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return { remaining, done: true };
        try {
          const parsed = JSON.parse(payload);
          const delta: string = parsed?.choices?.[0]?.delta?.content ?? "";
          if (delta) onDelta(delta);
        } catch { /* skip malformed */ }
      }
      return { remaining, done: false };
    };

    if (!wantsStream) {
      // Legacy path (BUG-12): buffer and return JSON for clients that didn't
      // ask for SSE, instead of always returning a stream they can't parse.
      let fullText = "";
      let sseBuffer = "";
      try {
        while (true) {
          // See readChunkWithIdleTimeout's header: the chain-selection timer
          // above bounds *finding* a model, not the stream that follows — a
          // provider that primes one token and stalls would otherwise hang
          // this request indefinitely, since nothing else is watching by now.
          const { done, value } = await readChunkWithIdleTimeout(reader);
          if (done) {
            sseBuffer += decoder.decode();
            if (sseBuffer) drainSSELines(sseBuffer + "\n", d => { fullText += d; tokenCount += estimateTokens(d); });
            break;
          }
          sseBuffer += decoder.decode(value, { stream: true });
          const result = drainSSELines(sseBuffer, d => { fullText += d; tokenCount += estimateTokens(d); });
          sseBuffer = result.remaining;
          if (result.done) break;
        }
      } finally {
        clearTimeout(timer);
        void recordAdditionalUsage(userId, tokenCount - promptTokens);
        reader.cancel().catch(() => {});
      }
      return NextResponse.json({ answer: fullText, grounded });
    }

    // SSE streaming path: re-emit the (already-primed, guaranteed non-empty)
    // OpenRouter stream, stripping `reasoning`/`reasoning_details` from each
    // frame first. Reasoning-capable models (nemotron-3-*-reasoning) put
    // their hidden chain-of-thought in those fields; the client only ever
    // renders `delta.content`, so forwarding them verbatim leaks internal
    // model reasoning to the browser for no benefit.
    const enc = new TextEncoder();
    let sseBuffer2 = "";
    const rewriteSSELine = (line: string): string => {
      if (!line.startsWith("data: ")) return line;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return line;
      try {
        const parsed = JSON.parse(payload);
        const choice = parsed?.choices?.[0];
        if (choice?.delta) {
          const delta: string = choice.delta.content ?? "";
          if (delta) tokenCount += estimateTokens(delta);
          delete choice.delta.reasoning;
          delete choice.delta.reasoning_details;
        }
        return `data: ${JSON.stringify(parsed)}`;
      } catch {
        return line;
      }
    };
    const stream = new ReadableStream({
      async start(ctrl2) {
        try {
          while (true) {
            const { done, value } = await readChunkWithIdleTimeout(reader);
            if (done) {
              sseBuffer2 += decoder.decode();
              if (sseBuffer2) ctrl2.enqueue(enc.encode(rewriteSSELine(sseBuffer2)));
              break;
            }
            sseBuffer2 += decoder.decode(value, { stream: true });
            const lines = sseBuffer2.split("\n");
            sseBuffer2 = lines.pop() ?? "";
            for (const line of lines) {
              ctrl2.enqueue(enc.encode(rewriteSSELine(line) + "\n"));
            }
          }
          ctrl2.close();
        } catch (err) {
          ctrl2.error(err);
        } finally {
          clearTimeout(timer);
          void recordAdditionalUsage(userId, tokenCount - promptTokens);
        }
      },
      cancel() {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
        ctrl.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "X-Portfolio-Health-Grounded": String(grounded),
      },
    });
  } catch (err) {
    clearTimeout(timer);
    // No model in the fallback chain answered — nothing was actually served,
    // so release the prompt reservation rather than charging the user's
    // budget for a call that never produced a response (matches the prior
    // behavior, where recordUsage was only ever reached after a response
    // object came back).
    void releaseTokens(userId, promptTokens);
    console.error("Health AI error", err);
    return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
  }
}
