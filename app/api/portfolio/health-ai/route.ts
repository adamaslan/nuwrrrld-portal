import { auth, currentUser } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { getWatchlist } from "@/lib/watchlist-store";
import type { PortfolioHealth } from "@/lib/portfolio";
import { gradeFromScore } from "@/lib/portfolio";
import { fetchWithModelFallbackChecked } from "@/lib/openrouter";
import { getPrecomputed, subjectFromTickers } from "@/lib/precomputed-ai-db";

const MCP_URL = process.env.MCP_BACKEND_URL;

// Stateless, ticker-keyed — mirrors app/api/portfolio/health/route.ts. No
// Clerk token is sent; gcp3's endpoint has no concept of "whose" portfolio
// this is, only "which tickers." See
// docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md.
async function fetchHealth(tickers: string[]): Promise<PortfolioHealth | null> {
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
    lines.push(`Portfolio health data: unavailable (no GCP3 backend connection)`);
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
  const tier = tierFromStatus(status);

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

  const health = await fetchHealth(watchlist);
  const prompt = buildHealthPrompt(watchlist, health);
  // Surfaced to the client so an ungrounded narrative is shown as such rather
  // than silently — see docs/wiki-portal/concept-graceful-degradation.md
  // ("degrade to a lesser state, never to a plausible-looking fabrication").
  const grounded = health !== null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);

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
          const { done, value } = await reader.read();
          if (done) {
            sseBuffer += decoder.decode();
            if (sseBuffer) drainSSELines(sseBuffer + "\n", d => { fullText += d; });
            break;
          }
          sseBuffer += decoder.decode(value, { stream: true });
          const result = drainSSELines(sseBuffer, d => { fullText += d; });
          sseBuffer = result.remaining;
          if (result.done) break;
        }
      } finally {
        clearTimeout(timer);
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
            const { done, value } = await reader.read();
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
    console.error("Health AI error", err);
    return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
  }
}
