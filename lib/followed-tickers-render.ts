/**
 * followed-tickers-render — rebuilds the human-readable markdown sections of
 * docs/tickers-followed.md from the harness's tables. The doc's *Current
 * cohort*, *Scoreboard*, and *Judge scorecard* sections are a rendering; the
 * runs rewrite them between marker comments, never by hand.
 *
 * Pure string work — no DB, no fs. The caller passes rows in and gets markdown
 * back, and does the read-modify-write of the file itself.
 */
import {
  aggregate,
  computeBaselines,
  HORIZONS,
  MIN_RESOLVED_FOR_RATE,
  type BaselineInput,
  type Horizon,
  type ScoredPick,
} from "@/lib/eval-scoring";

/** Section marker pairs. Content between each pair is replaced wholesale. */
export const MARKERS = {
  cohort: ["<!-- FT:COHORT:START -->", "<!-- FT:COHORT:END -->"],
  scoreboard: ["<!-- FT:SCOREBOARD:START -->", "<!-- FT:SCOREBOARD:END -->"],
  judge: ["<!-- FT:JUDGE:START -->", "<!-- FT:JUDGE:END -->"],
} as const;

/** Replace the text between a marker pair. If the markers aren't present the
 *  original text is returned unchanged (the run logs a warning) — never append
 *  a second copy of a section. */
export function replaceSection(
  doc: string,
  marker: readonly [string, string],
  replacement: string,
): string {
  const [start, end] = marker;
  const startIdx = doc.indexOf(start);
  const endIdx = doc.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return doc;
  return (
    doc.slice(0, startIdx + start.length) +
    "\n" +
    replacement.trimEnd() +
    "\n" +
    doc.slice(endIdx)
  );
}

const DASH = "—";

function pct(v: number | null, digits = 1): string {
  return v == null ? DASH : `${v.toFixed(digits)}%`;
}

function rateCell(n: number, rate: number | null): string {
  if (rate == null) return n === 0 ? `\`n<30\`` : `\`n=${n} <30\``;
  return `${rate.toFixed(1)}% (n=${n})`;
}

export interface CohortRow {
  ticker: string;
  direction: "bull" | "bear";
  added: string;
  entry: number;
  latestSignal: string;
  backtest: string;
  council: string;
  judge: number | null;
  daysHeld: number | null;
  thesisHolding: boolean;
}

export function renderCohort(rows: readonly CohortRow[], selectionRun: string): string {
  const bulls = rows.filter((r) => r.direction === "bull");
  const bears = rows.filter((r) => r.direction === "bear");

  const table = (rs: readonly CohortRow[], side: string) => {
    const header =
      "| Ticker | Direction | Added | Entry | Latest signal | Backtest | Council | Judge /10 | Days held | Thesis holding? |\n" +
      "|---|---|---|---|---|---|---|---|---|---|";
    if (rs.length === 0) {
      return `### ${side}\n\n${header}\n| _pending selection run_ | ${
        side === "Bulls (10)" ? "bull" : "bear"
      } | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`;
    }
    const body = rs
      .map(
        (r) =>
          `| ${r.ticker} | ${r.direction} | ${r.added} | ${r.entry} | ${r.latestSignal} | ${r.backtest} | ${r.council} | ${
            r.judge ?? DASH
          } | ${r.daysHeld ?? DASH} | ${r.thesisHolding ? "yes" : "**no**"} |`,
      )
      .join("\n");
    return `### ${side}\n\n${header}\n${body}`;
  };

  return [
    `**Selection run:** ${selectionRun}`,
    "",
    table(bulls, "Bulls (10)"),
    "",
    table(bears, "Bears (10)"),
  ].join("\n");
}

export interface ScoreboardHorizonInput {
  horizon: Horizon;
  scored: ScoredPick[];
  baselineRows: BaselineInput[];
}

export function renderScoreboard(
  perHorizon: readonly ScoreboardHorizonInput[],
  asOf: string,
): string {
  const byKey = new Map(perHorizon.map((h) => [h.horizon, h]));

  const rows = HORIZONS.map((h) => {
    const entry = byKey.get(h);
    if (!entry || entry.scored.length === 0) {
      return `| \`${h}\` | 0 | ${DASH} | ${DASH} | ${DASH} | ${DASH} | \`n<30\` | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`;
    }
    const agg = aggregate(entry.scored);
    const base = computeBaselines(entry.baselineRows);
    const vsLong =
      agg.hitRatePct != null && base.alwaysLongPct != null
        ? pct(agg.hitRatePct - base.alwaysLongPct)
        : DASH;
    const vsSpy =
      agg.hitRatePct != null && base.buyHoldSpyPct != null
        ? pct(agg.hitRatePct - base.buyHoldSpyPct)
        : DASH;
    const vsPrior =
      agg.hitRatePct != null && base.backtestPriorPct != null
        ? pct(agg.hitRatePct - base.backtestPriorPct)
        : DASH;
    return `| \`${h}\` | ${agg.n} | ${agg.hits} | ${agg.misses} | ${agg.flats} | ${agg.voids} | ${rateCell(
      agg.n,
      agg.hitRatePct,
    )} | ${pct(agg.meanDirectionalPct)} | ${vsLong} | ${vsSpy} | ${vsPrior} |`;
  });

  return [
    `**As of:** ${asOf}`,
    "",
    "| Horizon | n | Hit | Miss | Flat | Void | Hit-rate | Mean ret % | vs always-long | vs SPY | vs backtest prior |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

export interface JudgePeriodInput {
  period: string;
  verdictsGraded: number;
  meanTotal: number | null;
  criteriaMeans: Record<string, number | null>;
  goldAgreement: number | null;
}

export function renderJudgeScorecard(
  periods: readonly JudgePeriodInput[],
  asOf: string,
  judgeVersion: string,
): string {
  const header =
    "| Period | Verdicts graded | Mean /10 | Grounding | Falsifiability | Consistency | Specificity | Calibration | Gold-set agreement |\n" +
    "|---|---|---|---|---|---|---|---|---|";
  const body =
    periods.length === 0
      ? `| _pending first judge run_ | 0 | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} | ${DASH} |`
      : periods
          .map((p) => {
            const c = p.criteriaMeans;
            const cm = (k: string) => (c[k] == null ? DASH : c[k]!.toFixed(2));
            return `| ${p.period} | ${p.verdictsGraded} | ${
              p.meanTotal == null ? DASH : p.meanTotal.toFixed(1)
            } | ${cm("grounding")} | ${cm("falsifiability")} | ${cm("consistency")} | ${cm(
              "specificity",
            )} | ${cm("calibration")} | ${p.goldAgreement == null ? DASH : `${(p.goldAgreement * 100).toFixed(0)}%`} |`;
          })
          .join("\n");

  return [
    `Reasoning quality, independent of outcome. **Judge version:** \`${judgeVersion}\``,
    "",
    `**As of:** ${asOf}`,
    "",
    header,
    body,
  ].join("\n");
}

export { MIN_RESOLVED_FOR_RATE };
