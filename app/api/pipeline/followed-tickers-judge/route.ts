/**
 * POST /api/pipeline/followed-tickers-judge — weekly LLM-as-judge run.
 *
 * docs/tickers-followed.md §"Scoring: LLM as judge", follow-up item 5. Called by
 * .github/workflows/judge-followed-tickers.yml on Saturdays (off-market, so it
 * competes with neither the afternoon pipeline nor interactive Nu AI traffic
 * for the shared free-tier quota).
 *
 * Grades that week's resolved verdicts against the five-criterion rubric, then
 * re-grades the checked-in gold set. If the judge's agreement with the gold set
 * drops below 80%, the run's scores are DISCARDED, not published — the only
 * defense against silent judge drift when the free-tier chain swaps a model.
 *
 * The judge:
 *   - is outcome-blind (the prompt never contains realized price / outcome / date)
 *   - runs on a different free-tier model than the seat that authored the verdict
 *   - returns five integers + one-line justifications, never a holistic score
 *
 * Auth: Bearer CRON_SECRET.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import { buildGroundedBrief } from "@/lib/council-grounding";
import { runSeat, seatSystemPrompt, seatPrimaryModel } from "@/lib/openrouter";
import { logPipelineRun, type RunItem } from "@/lib/pipeline-run-log-db";
import type { StructuredVerdict } from "@/lib/council-verdict";
import {
  JUDGE_VERSION,
  compareToGold,
  evaluateGoldGate,
  judgeVerdict,
  type GoldEntry,
  type JudgeResult,
} from "@/lib/eval-judge";
import {
  getUnjudgedScoresSince,
  saveJudgeScore,
} from "@/lib/followed-tickers-db";

export const maxDuration = 300;

const GOLD_SET_PATH = join(
  process.cwd(),
  "__tests__",
  "fixtures",
  "followed-tickers-gold-set.json",
);

/** Judge seat: QUANT runs the smallest model in the chain and is never a T1/T2
 *  author, so it satisfies "different model than the author" for the current
 *  T1-authored verdicts. */
const JUDGE_SEAT = "QUANT" as const;

const SAMPLE_WINDOW_DAYS = 7;

async function loadGoldSet(): Promise<GoldEntry[]> {
  try {
    const raw = await readFile(GOLD_SET_PATH, "utf8");
    const parsed = JSON.parse(raw) as { entries?: GoldEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/**
 * Wrap runSeat as the `(prompt) => Promise<string>` that eval-judge expects,
 * recording one RunItem per call into `sink` as a side effect so the pipeline
 * run log (docs/model-usage/) sees which model served each grade. `phase`
 * labels the call's subject (gold-gate re-grade vs this week's sample).
 */
function makeJudgeCall(apiKey: string, sink: RunItem[], phase: () => string) {
  return async (prompt: string): Promise<string> => {
    // No maxTokens override: runSeat's default (1200) is the documented floor —
    // below it the reasoning models in FREE_MODEL_CHAIN burn the budget on
    // hidden chain-of-thought and hand back an empty completion, which the
    // gold-set gate then reads as judge drift (docs/free-model-rotation-status.md,
    // P3). 400 was well under that floor. The judge's own output (five ints +
    // short justifications) stays small; 1200 is a ceiling, not a target.
    try {
      const { answer, model, latencyMs } = await runSeat(
        JUDGE_SEAT,
        [
          { role: "system", content: seatSystemPrompt(JUDGE_SEAT) },
          { role: "user", content: prompt },
        ],
        apiKey,
      );
      sink.push({
        subject: phase(),
        seat: JUDGE_SEAT,
        model,
        outcome: answer.trim() ? "ok" : "empty",
        latencyMs,
        fallback: model !== seatPrimaryModel(JUDGE_SEAT),
      });
      return answer;
    } catch (err) {
      // runSeat's terminal-empty error is distinct from a transport/HTTP
      // failure — record "empty" for the former so the run log can tell a
      // starved chain apart from an unreachable one.
      const empty = err instanceof Error && /empty completion/i.test(err.message);
      sink.push({
        subject: phase(),
        seat: JUDGE_SEAT,
        model: null,
        outcome: empty ? "empty" : "fail",
      });
      return "";
    }
  };
}

/** Pull a StructuredVerdict back out of a stored council_json blob. */
function verdictFromJson(json: unknown): StructuredVerdict | null {
  if (!json || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  const { outlook, because, invalidation, execution } = j;
  if (
    typeof outlook === "string" &&
    typeof because === "string" &&
    typeof invalidation === "string" &&
    typeof execution === "string"
  ) {
    return { outlook, because, invalidation, execution };
  }
  return null;
}

/**
 * Cron entrypoint for the judge run. Bearer-authed. Runs the gold-set gate
 * first and bails (still logging a run row) if agreement is below threshold,
 * then grades this week's verdict sample. Every model call the judge makes is
 * captured into the pipeline run log (docs/model-usage/) so a later report can
 * show which model served each grade and whether the chain had to rescue it.
 * Accepts `{ dry_run?: boolean }`; a dry run grades but does not publish.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[followed-judge] CONFIG_ERROR: CRON_SECRET is not set.");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "AI not configured" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { dry_run?: boolean; session?: string };
  const dryRun = body.dry_run === true;
  // Optional caller label, threaded onto the run-log row for attribution
  // (docs/admin-console-todo.md §5.6). Cron callers omit it; the nulogdash
  // trigger action passes "nulogdash:<admin email>".
  const session = typeof body.session === "string" ? body.session : null;
  const judgeItems: RunItem[] = [];
  let phase = "gold-gate";
  const call = makeJudgeCall(apiKey, judgeItems, () => phase);

  // ── Gold-set gate first ───────────────────────────────────────────────────
  const goldSet = await loadGoldSet();
  const goldComparisons = [];
  for (const g of goldSet) {
    const result = await judgeVerdict(g.verdict, g.brief, call);
    if (!result) continue; // unparseable — treated as non-agreement below
    goldComparisons.push(compareToGold(g.id, g.goldTotal, result));
  }
  const gate = evaluateGoldGate(goldComparisons);

  if (!gate.passed) {
    await logPipelineRun({
      pipeline: "followed-tickers-judge",
      dryRun,
      session,
      itemsTotal: goldSet.length,
      items: judgeItems,
      summary: {
        published: false,
        goldSetSize: goldSet.length,
        goldAgreement: gate.agreementRate,
        reason: goldSet.length === 0 ? "no-gold-set" : "gold-agreement-below-80",
      },
    });
    return NextResponse.json({
      ok: true,
      judgeVersion: JUDGE_VERSION,
      published: false,
      reason:
        goldSet.length === 0
          ? "no gold set checked in — judge column is unfalsifiable (follow-up item 6)"
          : `gold-set agreement ${(gate.agreementRate * 100).toFixed(0)}% < 80% — scores discarded`,
      goldAgreement: gate.agreementRate,
      goldComparisons: gate.comparisons,
    });
  }

  // ── Grade this week's sample ──────────────────────────────────────────────
  phase = "sample";
  const since = new Date(Date.now() - SAMPLE_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const sample = await getUnjudgedScoresSince(since);

  let graded = 0;
  const totals: number[] = [];
  const criteriaSums: Record<string, number> = {
    grounding: 0,
    falsifiability: 0,
    consistency: 0,
    specificity: 0,
    calibration: 0,
  };
  const skipped: string[] = [];

  for (const item of sample) {
    const verdict = verdictFromJson(item.councilJson);
    if (!verdict) {
      skipped.push(`${item.pickId}:${item.horizon} (no parseable verdict)`);
      continue;
    }
    // Re-ground the brief for the judge from the same live source the author
    // used — the judge sees the brief and the verdict, nothing outcome-shaped.
    let result: JudgeResult | null = null;
    try {
      const brief = await buildGroundedBrief(
        `Directional outlook grading context.`,
        null,
        JUDGE_SEAT,
      );
      result = await judgeVerdict(verdict, brief, call);
    } catch {
      result = null;
    }
    if (!result) {
      skipped.push(`${item.pickId}:${item.horizon} (judge unparseable)`);
      continue;
    }

    if (!dryRun) {
      await saveJudgeScore(
        item.pickId,
        item.horizon,
        result.total,
        { scores: result.scores, justifications: result.justifications },
        JUDGE_VERSION,
      );
    }
    graded++;
    totals.push(result.total);
    for (const k of Object.keys(criteriaSums)) {
      criteriaSums[k] += result.scores[k as keyof typeof result.scores];
    }
  }

  const meanTotal = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;
  const criteriaMeans = Object.fromEntries(
    Object.entries(criteriaSums).map(([k, v]) => [k, graded ? v / graded : null]),
  );

  const runLogged = await logPipelineRun({
    pipeline: "followed-tickers-judge",
    dryRun,
    session,
    itemsTotal: goldSet.length + sample.length,
    items: judgeItems,
    summary: {
      published: !dryRun,
      goldSetSize: goldSet.length,
      goldAgreement: gate.agreementRate,
      sampleSize: sample.length,
      verdictsGraded: graded,
      skipped: skipped.length,
      meanTotal,
    },
  });

  return NextResponse.json({
    ok: true,
    judgeVersion: JUDGE_VERSION,
    published: !dryRun,
    dryRun,
    goldAgreement: gate.agreementRate,
    period: `${since}..${new Date().toISOString().slice(0, 10)}`,
    verdictsGraded: graded,
    meanTotal,
    criteriaMeans,
    skipped,
    runLogged,
  });
}
