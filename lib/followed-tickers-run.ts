/**
 * followed-tickers-run — the per-pick work shared by the daily observer route
 * and the one-off backfill script: one grounded council verdict, and resolving
 * the horizons that have come due against a pick's observation series.
 */
import { buildGroundedBrief } from "@/lib/council-grounding";
import { parseStructuredVerdict, directionFromOutlook } from "@/lib/council-verdict";
import { validateStructuredVerdict } from "@/lib/council-validate";
import { runSeat, seatSystemPrompt, seatPrimaryModel } from "@/lib/openrouter";
import { scorePick, type Horizon } from "@/lib/eval-scoring";
import {
  dueHorizons,
  horizonExit,
  tradingDaysBetween,
  ytdIsFinal,
} from "@/lib/shared/followed-tickers-policy";
import { upsertScore, type Pick } from "@/lib/followed-tickers-db";

export interface CouncilVerdict {
  direction: string;
  invalidation: string;
  raw: unknown;
  /** Which model actually served the T1 call, for the pipeline run log. */
  model: string;
  latencyMs: number;
  /** True when T1's primary lost and a FREE_MODEL_CHAIN entry served instead. */
  fallback: boolean;
  /** HTTP-200 with an empty completion after the chain was walked — distinct
   *  from a parse failure or a thrown error. */
  empty: boolean;
}

/** One grounded council seat, validated. Returns null on any failure so a
 *  degraded model chain doesn't abort the whole tracking run. The `error` /
 *  `empty` fields let the caller log *why* a ticker produced no verdict. */
export async function councilVerdictFor(
  ticker: string,
  apiKey: string,
): Promise<
  | { ok: true; verdict: CouncilVerdict }
  | { ok: false; empty: boolean; model: string | null }
> {
  try {
    const question = `Directional outlook for ${ticker} over the next 1-5 trading days.`;
    const brief = await buildGroundedBrief(question, ticker, "T1");
    // No maxTokens override: runSeat's default (1200) is the documented floor
    // below which the reasoning models in FREE_MODEL_CHAIN spend the whole
    // budget on hidden chain-of-thought and return a 0-character answer, which
    // here surfaced as councilVerdictFor -> null and the ticker being skipped
    // (docs/free-model-rotation-status.md, P3). 500 was under that floor.
    const { answer, model, latencyMs } = await runSeat(
      "T1",
      [
        { role: "system", content: seatSystemPrompt("T1") },
        { role: "user", content: `${brief}\n\n${question}` },
      ],
      apiKey,
    );
    const fallback = model !== seatPrimaryModel("T1");
    const verdict = parseStructuredVerdict(answer);
    if (!verdict) return { ok: false, empty: answer.trim().length === 0, model };
    // Two-layer contract: deterministic validators before anything downstream
    // trusts the verdict. A verdict with a hallucinated number is recorded but
    // flagged so the judge run can exclude it.
    const flags = validateStructuredVerdict(verdict, brief);
    return {
      ok: true,
      verdict: {
        direction: directionFromOutlook(verdict.outlook),
        invalidation: verdict.invalidation,
        raw: { ...verdict, validatorFlags: flags.map((f) => f.message) },
        model,
        latencyMs,
        fallback,
        empty: false,
      },
    };
  } catch (err) {
    // runSeat threw. It uses a distinct message when *every* model returned an
    // empty completion (vs. a hard transport/HTTP failure or a failed brief
    // build) — preserve that distinction so the run log shows "empty" not
    // "fail" for a chain that answered 200-but-blank all the way down.
    const empty = err instanceof Error && /empty completion/i.test(err.message);
    return { ok: false, empty, model: null };
  }
}

/**
 * Resolve every horizon that has come due for a pick against its observation
 * series, writing to followed_ticker_scores. Skips horizons already resolved
 * (except ytd, which is re-resolved until year end).
 */
export async function resolveDueHorizons(
  pick: Pick,
  observations: Array<{ observedOn: string; closePrice: number }>,
  alreadyResolved: Set<string>,
  now: Date,
): Promise<Horizon[]> {
  if (observations.length === 0) return [];
  const entryDate = new Date(pick.selectedAt);
  const elapsed = tradingDaysBetween(entryDate, now);
  const resolved: Horizon[] = [];

  const candidates: Horizon[] = [...dueHorizons(elapsed)];
  // ytd is always a candidate once a calendar year has been crossed; it
  // re-resolves in place until it becomes final on Dec 31.
  const crossedYear = now.getUTCFullYear() > entryDate.getUTCFullYear() ||
    (now.getUTCMonth() === 11 && now.getUTCDate() === 31);
  if (crossedYear) candidates.push("ytd");

  for (const horizon of candidates) {
    const key = `${pick.id}:${horizon}`;
    const ytdFinal = horizon === "ytd" && ytdIsFinal(entryDate, now);
    // Skip write-once horizons already done; for ytd, keep re-resolving until final.
    if (alreadyResolved.has(key) && (horizon !== "ytd" || ytdFinal)) continue;

    if (horizon === "ytd") {
      const exitObs =
        [...observations]
          .reverse()
          .find((o) => new Date(o.observedOn).getUTCFullYear() === entryDate.getUTCFullYear()) ??
        observations[observations.length - 1];
      await writeScore(pick, horizon, exitObs);
      resolved.push(horizon);
      continue;
    }

    const exit = horizonExit(observations, entryDate, horizon);
    if (exit.kind === "pending") continue;
    if (exit.kind === "void") {
      // The horizon's own close is missing. Score it void against the last
      // observation date, never against a later close.
      await writeScore(pick, horizon, observations[observations.length - 1], { isVoid: true });
    } else {
      await writeScore(pick, horizon, exit.observation);
    }
    resolved.push(horizon);
  }
  return resolved;
}

/** Score one pick at one horizon against an exit observation, or void it. */
async function writeScore(
  pick: Pick,
  horizon: Horizon,
  exitObs: { observedOn: string; closePrice: number },
  { isVoid = false }: { isVoid?: boolean } = {},
): Promise<void> {
  const scored = scorePick({
    direction: pick.direction,
    entryPrice: pick.entryPrice,
    exitPrice: exitObs.closePrice,
    horizon,
    void: isVoid || pick.droppedAt != null,
  });
  const voided = scored.outcome === "void";
  await upsertScore({
    pickId: pick.id,
    horizon,
    resolvedOn: exitObs.observedOn,
    exitPrice: voided ? null : exitObs.closePrice,
    returnPct: voided ? null : scored.returnPct,
    directional: voided ? null : scored.directional,
    outcome: scored.outcome,
  });
}

