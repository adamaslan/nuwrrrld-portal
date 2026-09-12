/**
 * Local answer path for per-ticker signal chat.
 *
 * `POST /api/signals/{ticker}/chat` was a thin proxy to
 * `{gcp3-backend-url}/signals/{ticker}/chat`, an endpoint that is **not
 * registered on gcp3** — its live OpenAPI lists ~38 paths and no per-signal
 * chat among them (only `/agents/swing/{run_id}/chat` and
 * `/agents/growth/{run_id}/chat`, which are run-keyed and a different
 * contract). Every call therefore 404'd upstream and the route returned a flat
 * `503 { error: "signal chat unavailable" }` to every user, always. Found by
 * the /nulogdash sweep once it could actually authenticate.
 *
 * This is the same situation, and takes the same shape, as
 * docs/wiki-portal/decision-local-portfolio-scoring-over-upstream-wait.md: the
 * portal cannot deploy gcp3, the data it needs is already reachable, and
 * waiting is a choice being made by nobody. Upstream stays preferred and wins
 * whenever it answers the contract; everything else grounds locally on
 * `/signals/{ticker}` — a path that *is* registered — and answers with the
 * portal's own OpenRouter client.
 *
 * What this deliberately does NOT do is invent data. If the grounding fetch
 * fails there is no answer to give, and the caller surfaces that rather than
 * letting a model speculate about a ticker it was told nothing about.
 */
import { runSeat } from "@/lib/openrouter";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const GROUNDING_TIMEOUT_MS = 8_000;

/** Answer budget. Signal chat is a single question, not a deliberation — the
 *  council's 1200 is sized for four labeled fields, which this does not emit. */
const ANSWER_MAX_TOKENS = 700;

/** The shape the route returns, matching what the upstream proxy documented so
 *  existing callers keep working. `fallback_used` was already part of that
 *  contract, which is convenient: a locally-answered reply is exactly what it
 *  was meant to flag. */
export interface SignalChatAnswer {
  ticker: string;
  answer: string;
  tool_calls: string[];
  fallback_used: boolean;
  created_at: string;
  model?: string;
}

export interface TimeframeSignal {
  direction?: string;
  confidence?: number;
  timeframe?: string;
  ai_degraded?: boolean;
  evidence?: { items?: Array<{ summary?: string; is_counter?: boolean }> };
}

export interface UpstreamSignal {
  ticker?: string;
  signals?: Record<string, TimeframeSignal>;
  alignment_score?: number;
  divergence_pattern?: string;
  divergence_interpretation?: string;
  computed_at?: string;
}

/**
 * Fetch the one upstream path that does exist. Returns null on every failure
 * mode, including a 200 whose body is not this contract — the same
 * shape-validating miss that portfolio health learned to treat as a miss rather
 * than coerce into a wrong-but-plausible answer.
 */
async function fetchSignalGrounding(ticker: string): Promise<UpstreamSignal | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GROUNDING_TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals/${encodeURIComponent(ticker)}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!raw || typeof raw !== "object") return null;
    const sig = raw as UpstreamSignal;
    // `signals` is the load-bearing field — without at least one timeframe
    // there is nothing to ground an answer in, and a chat reply built on an
    // empty object would be pure speculation wearing a data-backed voice.
    if (!sig.signals || Object.keys(sig.signals).length === 0) return null;
    return sig;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Render the signal payload as compact, labeled evidence.
 *
 * Deliberately flags `ai_degraded` timeframes in the text the model reads.
 * gcp3 currently serves rule-based fallback signals for most tickers
 * (`prompt_version: "fallback_v1"`), and a model told only "buy, confidence
 * 0.55" will narrate that as a considered AI view. Naming the degradation is
 * what keeps the answer honest about the strength of its own basis — the same
 * reason portfolio health reports coverage instead of hiding it.
 */
export function buildGroundingBlock(sig: UpstreamSignal): string {
  const lines: string[] = [];
  for (const [tf, s] of Object.entries(sig.signals ?? {})) {
    const conf = typeof s.confidence === "number" ? `${Math.round(s.confidence * 100)}%` : "n/a";
    const evidence = (s.evidence?.items ?? [])
      .map((i) => i.summary)
      .filter(Boolean)
      .join("; ");
    const degraded = s.ai_degraded ? " [rule-based fallback, not an AI read]" : "";
    lines.push(`${tf}: ${s.direction ?? "unknown"} @ ${conf}${degraded}${evidence ? ` — ${evidence}` : ""}`);
  }
  if (typeof sig.alignment_score === "number") {
    lines.push(`Alignment across timeframes: ${sig.alignment_score}`);
  }
  if (sig.divergence_pattern) {
    lines.push(
      `Divergence pattern: ${sig.divergence_pattern}` +
        (sig.divergence_interpretation ? ` — ${sig.divergence_interpretation}` : ""),
    );
  }
  return lines.join("\n");
}

const SYSTEM = [
  "You answer one question about one ticker's technical signal, for a retail investor.",
  "Ground every claim in the SIGNAL DATA block. Quote the timeframe you are relying on.",
  "When a timeframe is marked as a rule-based fallback, say that its basis is weak rather than presenting it as an AI judgement.",
  "You provide informational analysis only — not personalised financial advice.",
  "Answer in at most 150 words, plain prose, no preamble.",
].join(" ");

/**
 * Answer a signal question locally. Throws when grounding is unavailable —
 * the caller turns that into an honest unavailable state, which is the correct
 * terminal answer (concept-graceful-degradation) rather than an ungrounded one.
 */
export async function localSignalChat(ticker: string, question: string): Promise<SignalChatAnswer> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");

  const sig = await fetchSignalGrounding(ticker);
  if (!sig) throw new Error(`no signal data available for ${ticker}`);

  const result = await runSeat(
    "T1",
    [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          `Question about ${ticker}: ${question}\n\n` +
          `=== SIGNAL DATA (${ticker}${sig.computed_at ? `, computed ${sig.computed_at}` : ""}) ===\n` +
          buildGroundingBlock(sig),
      },
    ],
    apiKey,
    ANSWER_MAX_TOKENS,
  );

  return {
    ticker,
    answer: result.answer,
    tool_calls: [],
    fallback_used: true,
    created_at: new Date().toISOString(),
    model: result.model,
  };
}
