/**
 * backfill-followed-tickers — fill the observation gaps the daily observer left
 * (it ran before any close was available, so whole days were skipped), resolve
 * the horizons those closes make due, and optionally attach one grounded council
 * verdict to each pick's latest observation so the weekly judge has something to
 * grade.
 *
 *   Dry run (default; writes nothing):
 *     npx tsx --env-file=.env.local scripts/backfill-followed-tickers.ts
 *   Write:
 *     npx tsx --env-file=.env.local scripts/backfill-followed-tickers.ts --apply
 *   Also generate verdicts for the latest observation (free-tier model calls):
 *     npx tsx --env-file=.env.local scripts/backfill-followed-tickers.ts --apply --council
 *   Re-run only for picks whose latest observation has no usable verdict yet:
 *     npx tsx --env-file=.env.local scripts/backfill-followed-tickers.ts --apply --council --only-missing
 *
 * Closes come from Alpaca SIP daily bars (split-adjusted), the same source as the
 * entry prices. An existing observation is never overwritten, and a session that
 * has not closed yet is never recorded. A backfilled verdict is written with
 * `backfilled: true` so it can be told apart from one captured on the day.
 */
import { fetchAlpacaDailyBars } from "@/lib/alpaca-daily-bars";
import { nyDateOf } from "@/lib/followed-tickers-price";
import { councilVerdictFor, resolveDueHorizons } from "@/lib/followed-tickers-run";
import {
  getLivePicks,
  getObservations,
  getResolvedHorizons,
  setObservationCouncil,
  upsertObservation,
} from "@/lib/followed-tickers-db";

const NY_CLOSE_HOUR = 16;
const NY_CLOSE_SETTLE_MINUTES = 5;
const COUNCIL_PAUSE_MS = 1_500;

const apply = process.argv.includes("--apply");
const withCouncil = process.argv.includes("--council");
const onlyMissing = process.argv.includes("--only-missing");

/** A stored verdict that is just the model saying it had no data. */
const NO_DATA_VERDICT = /no (grounding )?data/i;

function hasUsableVerdict(councilJson: unknown): boolean {
  if (!councilJson || typeof councilJson !== "object") return false;
  const because = (councilJson as { because?: unknown }).because;
  return typeof because === "string" && !NO_DATA_VERDICT.test(because);
}

/** Latest NY session date whose close is final: today once settled past 16:00 ET,
 *  otherwise the previous calendar day (non-sessions simply have no bar). */
function lastClosedSessionDate(now: Date): string {
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(clock.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(clock.find((p) => p.type === "minute")?.value ?? 0);
  const settled = hour * 60 + minute >= NY_CLOSE_HOUR * 60 + NY_CLOSE_SETTLE_MINUTES;
  return settled ? nyDateOf(now) : nyDateOf(new Date(now.getTime() - 86_400_000));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const now = new Date();
  const lastClosed = lastClosedSessionDate(now);
  const picks = await getLivePicks();
  console.log(`${apply ? "APPLY" : "DRY RUN"} · ${picks.length} live picks · last closed session ${lastClosed}`);
  if (picks.length === 0) return;

  const startDate = picks.map((p) => nyDateOf(new Date(p.selectedAt))).sort()[0];
  const bars = await fetchAlpacaDailyBars(
    picks.map((p) => p.ticker),
    startDate,
    lastClosed,
  );

  const alreadyResolved = await getResolvedHorizons();
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (withCouncil && !apiKey) console.warn("--council requested but OPENROUTER_API_KEY is not set; skipping verdicts");

  let observationsAdded = 0;
  let scoresWritten = 0;
  let verdictsAdded = 0;
  const noBars: string[] = [];

  for (const pick of picks) {
    const entryDay = nyDateOf(new Date(pick.selectedAt));
    const tickerBars = bars.get(pick.ticker) ?? [];
    if (tickerBars.length === 0) noBars.push(pick.ticker);

    const existing = await getObservations(pick.id);
    const have = new Set(existing.map((o) => o.observedOn.slice(0, 10)));
    const missing = tickerBars.filter(
      (b) => b.date > entryDay && b.date <= lastClosed && !have.has(b.date),
    );

    for (const bar of missing) {
      observationsAdded++;
      if (!apply) continue;
      await upsertObservation({
        pickId: pick.id,
        observedOn: bar.date,
        closePrice: bar.close,
        priceSource: "alpaca_daily_bar",
        signalDir: null,
        backtestRate: null,
        councilJson: null,
      });
    }

    if (!apply) {
      console.log(`${pick.ticker.padEnd(6)} +${missing.length} observations (${missing.map((b) => b.date).join(", ") || "none"})`);
      continue;
    }

    const series = await getObservations(pick.id);
    const resolved = await resolveDueHorizons(pick, series, alreadyResolved, now);
    scoresWritten += resolved.length;

    if (withCouncil && apiKey && series.length > 0) {
      const latest = series[series.length - 1];
      if (onlyMissing && hasUsableVerdict(latest.councilJson)) continue;
      let result = await councilVerdictFor(pick.ticker, apiKey);
      // The free-tier chain returns an empty completion often enough that one
      // retry meaningfully raises coverage; more would just burn quota.
      if (!result.ok) result = await councilVerdictFor(pick.ticker, apiKey);
      if (result.ok) {
        await setObservationCouncil(pick.id, latest.observedOn.slice(0, 10), {
          ...(result.verdict.raw as object),
          backfilled: true,
        });
        verdictsAdded++;
      } else {
        console.warn(`${pick.ticker}: no council verdict (${result.empty ? "empty completion" : "failed"})`);
      }
      await sleep(COUNCIL_PAUSE_MS);
    }
    console.log(`${pick.ticker.padEnd(6)} +${missing.length} observations, resolved [${resolved.join(", ")}]`);
  }

  console.log(
    `\nobservations ${apply ? "added" : "to add"}: ${observationsAdded}` +
      (apply ? ` · horizons resolved: ${scoresWritten} · verdicts: ${verdictsAdded}` : ""),
  );
  if (noBars.length) console.warn(`no Alpaca bars for: ${noBars.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
