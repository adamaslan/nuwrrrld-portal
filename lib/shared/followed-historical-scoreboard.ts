/** Offline reconstructed-cohort consumer. No storage, providers, or live-view mutation.
 * The caller must verify artifact BYTES against its independent digest before parsing.
 * Detector pooled buckets are deliberately not accepted as frozen cohort outcomes.
 */
import { z } from "zod";
import { HORIZONS, HORIZON_TRADING_DAYS, scorePick, type Horizon } from "@/lib/eval-scoring";
import { tradingDaysBetween, MAX_EXIT_LAG_TRADING_DAYS } from "@/lib/shared/followed-tickers-policy";
import { buildFollowedTickersView, type RawPick, type RawScore, type ScoreboardRowVM } from "@/lib/shared/followed-tickers-view";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  const d = new Date(s);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const frozenPick = z.object({
  id: z.string().trim().min(1), ticker: z.string().trim().min(1), cohortMonth: date,
  selectedOn: date, inputsThrough: date,
  direction: z.enum(["bull", "bear"]), entryPrice: z.number().finite().positive(),
}).strict();
const exit = z.object({
  pickId: z.string().min(1), horizon: z.enum(["d1", "w1", "m1", "m3", "m6", "ytd", "y1"]),
  resolvedOn: date, exitPrice: z.number().finite().positive().nullable(),
  status: z.enum(["measured", "missing_price"]),
}).strict();
const schema = z.object({
  format: z.literal("followed-cohort-reconstruction-v1"),
  mode: z.literal("reconstructed_point_in_time"),
  horizonPolicy: z.literal("followed-weekdays-lag1-yearend-v1"),
  runId: z.string().min(1), engineSha256: hash, universeSha256: hash,
  decisionStart: date, decisionEnd: date, observationCutoff: date,
  priceBasis: z.string().min(1),
  picks: z.array(frozenPick), exits: z.array(exit),
}).strict();
export type HistoricalCohortArtifact = z.infer<typeof schema>;
export interface HistoricalScoreboardVM {
  mode: "reconstructed";
  label: "Historical backtest reconstruction, not a live track record";
  runId: string;
  priceBasis: string;
  decisionStart: string;
  decisionEnd: string;
  observationCutoff: string;
  cohortCount: number;
  pickCount: number;
  scoreboard: ScoreboardRowVM[];
  /** Missing outcome records remain unmeasured, never synthesized as losses/voids. */
  unmeasuredByHorizon: Record<Horizon, number>;
  councilHistory: "not_available";
  judgeHistory: "not_available";
}
export type HistoricalScoreboardResult =
  | { status: "invalid"; reason: string }
  | { status: "ready"; view: HistoricalScoreboardVM };

/** Expected provenance is supplied from a trusted run registry, never the artifact itself.
 * This is a consumer, not a claim that the run's point-in-time inputs were audited.
 * Each call consumes one basis/run; combining feeds or experiments is forbidden.
 */
export function buildHistoricalScoreboard(input: unknown, expected: {
  runId: string; engineSha256: string; universeSha256: string; today: string;
  /** Independently verified last exchange session for each entry year, when YTD is supplied. */
  yearEndSessions?: Readonly<Record<string, string>>;
}): HistoricalScoreboardResult {
  const invalid = (reason: string): HistoricalScoreboardResult => ({ status: "invalid", reason });
  const parsed = schema.safeParse(input);
  if (!parsed.success || !date.safeParse(expected.today).success) return invalid("invalid frozen cohort artifact");
  const a = parsed.data;
  if (a.runId !== expected.runId || a.engineSha256 !== expected.engineSha256 || a.universeSha256 !== expected.universeSha256)
    return invalid("provenance mismatch");
  if (a.decisionStart > a.decisionEnd || a.decisionEnd > a.observationCutoff || a.observationCutoff > expected.today)
    return invalid("invalid reconstruction window");
  const picks = new Map<string, z.infer<typeof frozenPick>>();
  const monthlySymbols = new Set<string>();
  for (const p of a.picks) {
    const key = `${p.cohortMonth}:${p.ticker.toUpperCase()}`;
    if (picks.has(p.id) || monthlySymbols.has(key)) return invalid("duplicate pick");
    if (p.cohortMonth.slice(8) !== "01" || p.cohortMonth.slice(0, 7) !== p.selectedOn.slice(0, 7)
      || p.selectedOn < a.decisionStart || p.selectedOn > a.decisionEnd || p.inputsThrough > p.selectedOn)
      return invalid("invalid pick date or future decision input");
    picks.set(p.id, p); monthlySymbols.add(key);
  }
  const scores: RawScore[] = [];
  const keys = new Set<string>();
  for (const e of a.exits) {
    const p = picks.get(e.pickId), key = `${e.pickId}:${e.horizon}`;
    if (!p || keys.has(key)) return invalid("unknown or duplicate outcome");
    if (e.resolvedOn <= p.selectedOn || e.resolvedOn > a.observationCutoff)
      return invalid("outcome outside observation window");
    let late = false;
    if (e.horizon === "ytd") {
      const year = p.selectedOn.slice(0, 4), yearEnd = `${year}-12-31`;
      const finalSession = expected.yearEndSessions?.[year];
      if (!finalSession || !date.safeParse(finalSession).success || finalSession.slice(0, 4) !== year
        || a.observationCutoff < yearEnd || e.resolvedOn !== finalSession)
        return invalid("YTD requires a verified final exchange session");
    } else {
      const elapsed = tradingDaysBetween(new Date(p.selectedOn), new Date(e.resolvedOn));
      if (elapsed < HORIZON_TRADING_DAYS[e.horizon]) return invalid("premature horizon outcome");
      late = elapsed - HORIZON_TRADING_DAYS[e.horizon] > MAX_EXIT_LAG_TRADING_DAYS;
    }
    if ((e.status === "measured") !== (e.exitPrice !== null)) return invalid("price status mismatch");
    const scored = scorePick({ direction: p.direction, entryPrice: p.entryPrice,
      exitPrice: e.exitPrice ?? 0, horizon: e.horizon, void: late || e.status === "missing_price" });
    scores.push({ pickId: p.id, horizon: e.horizon, ...scored, judgeScore: null, resolvedOn: e.resolvedOn });
    keys.add(key);
  }
  const rawPicks: RawPick[] = a.picks.map(p => ({ ...p, confidence: null, droppedAt: null }));
  const view = buildFollowedTickersView({ picks: rawPicks, observationsByPick: {}, scores, now: new Date(a.observationCutoff) });
  const unmeasuredByHorizon = Object.fromEntries(HORIZONS.map(h => [h, a.picks.length - scores.filter(s => s.horizon === h).length])) as Record<Horizon, number>;
  return { status: "ready", view: {
    mode: "reconstructed", label: "Historical backtest reconstruction, not a live track record",
    runId: a.runId, priceBasis: a.priceBasis, decisionStart: a.decisionStart, decisionEnd: a.decisionEnd,
    observationCutoff: a.observationCutoff, cohortCount: new Set(a.picks.map(p => p.cohortMonth)).size,
    pickCount: a.picks.length, scoreboard: view.scoreboard, unmeasuredByHorizon,
    councilHistory: "not_available", judgeHistory: "not_available",
  } };
}
