import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { buildCard } from "@/lib/shared/card-policy";
import {
  ALPACA_ADJUSTMENT,
  ALPACA_FEED,
  ALPACA_PAGE_LIMIT,
  FETCH_CHUNK_SIZE,
  LOOKBACK_DAYS,
  MIN_BARS,
  MIN_COVERAGE_RATIO,
  SIP_DELAY_MINUTES,
} from "@/lib/shared/hydration-constants";
import { unservableWithinCeiling } from "@/lib/shared/hydrate-rows";
import {
  adx,
  confluence,
  macdCross,
  newYorkDate,
  rsi,
  sipHistoryEnd,
  unservableRow,
  volatilityPercentile,
} from "@/scripts/lib/hydrate-indicators.mjs";

const CARD_BATCH_SIZE = 500;
const ALPACA_REQUEST_TIMEOUT_MS = 15_000;
const HYDRATION_SOURCE = "alpaca:sip:1Day";
const MARKET_CLOSE_MINUTES = 16 * 60;
const INVALID_SYMBOL_PATTERN = /invalid symbol:\s*([^"'}\s]+)/i;

// Counted rather than reserved: there is no shared Alpaca budget to wait on.
let alpacaRequests = 0;

interface UniverseRow {
  ticker: string;
  universe: "stock" | "etf";
  name: string | null;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

function parseBar(value: unknown): AlpacaBar | null {
  if (!value || typeof value !== "object") return null;
  const bar = value as Record<string, unknown>;
  if (
    typeof bar.t !== "string"
    || ![bar.o, bar.h, bar.l, bar.c].every((number) => typeof number === "number" && Number.isFinite(number))
  ) {
    return null;
  }
  return {
    t: bar.t,
    o: bar.o as number,
    h: bar.h as number,
    l: bar.l as number,
    c: bar.c as number,
  };
}

interface ComputedRow {
  ticker: string;
  universe: "stock" | "etf";
  barDate: string;
  rsi: number | null;
  macdCross?: "bullish" | "bearish" | null;
  adx: number | null;
  volatilityPercentile: number | null;
  confluenceScore: number | null;
  direction: "bullish" | "bearish" | "neutral" | null;
  frameStats: {
    barCount: number;
    nanRatio: number;
    staleTradingDays: number;
  };
}

interface RunItem {
  subject: string;
  model: null;
  outcome: "ok" | "fail" | "skip";
}

type NeonSql = NeonQueryFunction<false, false>;

interface CardWrite {
  ticker: string;
  horizon: "t1" | "t2";
  universe: "stock" | "etf";
  state_key: string;
  taxonomy_version: string;
  score: number;
  score_version: string;
  action: "BUY" | "HOLD" | "SELL";
  tokens: object;
  numerics: Record<string, never>;
  data_quality: number;
  missing_fields: string[];
  source: string;
  source_run_id: string;
  bar_date: string;
  is_final: boolean;
  observed_at: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
}

function databaseHost(connectionString: string, name: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL connection URI`);
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol) || !url.hostname.endsWith(".neon.tech")) {
    throw new Error(`${name} must point to a Neon PostgreSQL endpoint`);
  }
  return url.hostname.toLowerCase();
}

function neonEndpointId(host: string): string {
  return host.split(".", 1)[0].replace(/-pooler$/, "");
}

function assertHydrationTarget(sourceUrl: string, targetUrl: string): void {
  const branchName = requiredEnv("HYDRATION_NEON_BRANCH_NAME");
  const endpointId = requiredEnv("HYDRATION_NEON_ENDPOINT_ID");
  if (branchName !== "nwf-hydration") {
    throw new Error("HYDRATION_NEON_BRANCH_NAME must be nwf-hydration");
  }

  const sourceHost = databaseHost(sourceUrl, "SOURCE_DATABASE_URL");
  const targetHost = databaseHost(targetUrl, "HYDRATION_DATABASE_URL");
  const sourceEndpointId = neonEndpointId(sourceHost);
  const targetEndpointId = neonEndpointId(targetHost);
  if (sourceEndpointId === targetEndpointId || targetEndpointId !== endpointId) {
    throw new Error("Hydration database endpoint guard rejected the target");
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function tradingDaysStale(lastBarDate: string): number {
  const last = new Date(`${lastBarDate}T00:00:00Z`);
  const today = new Date(`${newYorkDate()}T00:00:00Z`);
  if (!Number.isFinite(last.getTime()) || today <= last) return 0;

  let count = 0;
  const cursor = new Date(last);
  while (cursor < today) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor >= today) break;
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

function frameStatsFor(bars: AlpacaBar[]): ComputedRow["frameStats"] {
  const values = bars.flatMap((bar) => [bar.o, bar.h, bar.l, bar.c]);
  const invalid = values.filter((value) => !Number.isFinite(value)).length;
  const lastBarDate = newYorkDate(bars.at(-1)!.t);
  return {
    barCount: bars.length,
    nanRatio: values.length === 0 ? 1 : invalid / values.length,
    staleTradingDays: tradingDaysStale(lastBarDate),
  };
}

function computeRow(ticker: string, universe: "stock" | "etf", bars: AlpacaBar[]): ComputedRow | null {
  if (unservableRow(ticker, bars)) return null;
  const sorted = [...bars].sort((left, right) => left.t.localeCompare(right.t));
  const close = sorted.map((bar) => bar.c);
  const high = sorted.map((bar) => bar.h);
  const low = sorted.map((bar) => bar.l);

  const rsiValue = rsi(close);
  const macdValue = macdCross(close);
  const adxValue = adx(high, low, close);
  const volatilityValue = volatilityPercentile(close);
  const combined = confluence(rsiValue, macdValue === "missing" ? undefined : macdValue, adxValue);
  const direction = combined.direction !== null
    && ["bullish", "bearish", "neutral"].includes(combined.direction)
    ? combined.direction as ComputedRow["direction"]
    : null;
  const row: ComputedRow = {
    ticker,
    universe,
    barDate: newYorkDate(sorted.at(-1)!.t),
    rsi: rsiValue,
    adx: adxValue,
    volatilityPercentile: volatilityValue,
    confluenceScore: combined.score,
    direction,
    frameStats: frameStatsFor(sorted),
  };
  if (macdValue !== "missing") row.macdCross = macdValue;
  return row;
}

async function fetchBarsOnce(
  symbols: string[],
  startDate: string,
  endDate: string,
  apiKey: string,
  apiSecret: string,
): Promise<Map<string, AlpacaBar[]>> {
  const barsBySymbol = new Map<string, AlpacaBar[]>();
  let pageToken: string | undefined;

  do {
    const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("timeframe", "1Day");
    url.searchParams.set("start", startDate);
    url.searchParams.set("end", endDate);
    url.searchParams.set("limit", String(ALPACA_PAGE_LIMIT));
    url.searchParams.set("feed", ALPACA_FEED);
    url.searchParams.set("adjustment", ALPACA_ADJUSTMENT);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    alpacaRequests += 1;
    const response = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
      },
      signal: AbortSignal.timeout(ALPACA_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`Alpaca bars request failed with HTTP ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as {
      bars?: Record<string, unknown[]>;
      next_page_token?: string | null;
    };
    for (const [symbol, symbolBars] of Object.entries(payload.bars ?? {})) {
      const accumulated = barsBySymbol.get(symbol) ?? [];
      accumulated.push(...symbolBars.map(parseBar).filter((bar): bar is AlpacaBar => bar !== null));
      barsBySymbol.set(symbol, accumulated);
    }
    pageToken = payload.next_page_token ?? undefined;
  } while (pageToken);

  return barsBySymbol;
}

/**
 * Bars for a batch, where one unusable symbol costs only itself.
 *
 * Alpaca rejects the whole request with a 400 "invalid symbol: X" if any one
 * symbol is not a US equity. The universe holds such a symbol today (a
 * preferred share stored with a hyphen), so without this the run would abort at
 * its batch and never hydrate any later one. Drop the named symbol and retry the
 * rest; any other failure (auth, rate limit, network) still throws.
 */
export async function fetchBars(
  symbols: string[],
  startDate: string,
  endDate: string,
  apiKey: string,
  apiSecret: string,
): Promise<Map<string, AlpacaBar[]>> {
  let remaining = [...symbols];
  const dropped: string[] = [];

  // Bounded by construction: each pass removes at least one symbol.
  while (remaining.length > 0) {
    try {
      const bars = await fetchBarsOnce(remaining, startDate, endDate, apiKey, apiSecret);
      if (dropped.length > 0) {
        console.log(`  (skipped ${dropped.length} unusable: ${dropped.join(", ")})`);
      }
      return bars;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const bad = INVALID_SYMBOL_PATTERN.exec(message)?.[1];
      if (!bad || !remaining.includes(bad)) throw error;
      dropped.push(bad);
      remaining = remaining.filter((symbol) => symbol !== bad);
    }
  }

  console.log(`  (skipped ${dropped.length} unusable: ${dropped.join(", ")})`);
  return new Map();
}

async function upsertUniverse(
  targetSql: NeonSql,
  rows: UniverseRow[],
): Promise<void> {
  for (const batch of chunks(rows, CARD_BATCH_SIZE)) {
    await targetSql`
      INSERT INTO ticker_universe (ticker, universe, name, active)
      SELECT ticker, universe, name, true
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb)
          AS incoming(ticker text, universe text, name text)
      ON CONFLICT (ticker) DO UPDATE SET
        universe = EXCLUDED.universe,
        name = COALESCE(EXCLUDED.name, ticker_universe.name),
        active = true
    `;
  }
}

export async function upsertCards(
  targetSql: NeonSql,
  cards: CardWrite[],
): Promise<{ written: number; accepted: number }> {
  let written = 0;
  for (const batch of chunks(cards, CARD_BATCH_SIZE)) {
    const rows = await targetSql`
      INSERT INTO ticker_cards (
        ticker, horizon, universe, state_key, taxonomy_version,
        score, score_version, action, tokens, numerics,
        data_quality, missing_fields, source, source_run_id, bar_date,
        is_final, observed_at
      )
      SELECT ticker, horizon, universe, state_key, taxonomy_version,
             score, score_version, action, tokens, numerics,
             data_quality, missing_fields, source, source_run_id, bar_date,
             is_final, observed_at
        FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS incoming(
          ticker text, horizon text, universe text, state_key text,
          taxonomy_version text, score real, score_version text, action text,
          tokens jsonb, numerics jsonb, data_quality real, missing_fields text[],
          source text, source_run_id text, bar_date date, is_final boolean,
          observed_at timestamptz
        )
      ON CONFLICT (ticker, horizon) DO UPDATE SET
        universe = EXCLUDED.universe,
        state_key = EXCLUDED.state_key,
        taxonomy_version = EXCLUDED.taxonomy_version,
        score = EXCLUDED.score,
        score_version = EXCLUDED.score_version,
        action = EXCLUDED.action,
        tokens = EXCLUDED.tokens,
        numerics = EXCLUDED.numerics,
        data_quality = EXCLUDED.data_quality,
        missing_fields = EXCLUDED.missing_fields,
        source = EXCLUDED.source,
        source_run_id = EXCLUDED.source_run_id,
        bar_date = EXCLUDED.bar_date,
        is_final = EXCLUDED.is_final,
        observed_at = EXCLUDED.observed_at,
        computed_at = now()
      WHERE EXCLUDED.bar_date > ticker_cards.bar_date
         OR (EXCLUDED.bar_date = ticker_cards.bar_date AND (
           (EXCLUDED.is_final AND NOT ticker_cards.is_final)
           OR (EXCLUDED.is_final AND ticker_cards.is_final
               AND EXCLUDED.data_quality > ticker_cards.data_quality)
           OR (NOT EXCLUDED.is_final AND NOT ticker_cards.is_final AND (
             EXCLUDED.data_quality > ticker_cards.data_quality
             OR (EXCLUDED.data_quality = ticker_cards.data_quality AND (
               EXCLUDED.observed_at IS NULL
               OR ticker_cards.observed_at IS NULL
               OR EXCLUDED.observed_at > ticker_cards.observed_at
             ))
           ))
         ))
      RETURNING ticker
    `;
    written += rows.length;
  }
  return { written, accepted: cards.length };
}

/**
 * Whether the daily bar for `barDate` is complete.
 *
 * The request end is held back by SIP_DELAY_MINUTES, so at 16:00 New York the
 * day's bar still ends at about 15:40. Calling it final at the bell would store
 * a partial bar as final, and the upsert rule would then refuse a later final of
 * equal quality. Wait out the delay.
 */
export function isFinalBar(now: Date, barDate: string): boolean {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => local.find((item) => item.type === type)?.value;
  const weekday = part("weekday");
  const minutesSinceMidnight = Number(part("hour")) * 60 + Number(part("minute"));
  const weekend = weekday === "Sat" || weekday === "Sun";
  const sipSettled = minutesSinceMidnight >= MARKET_CLOSE_MINUTES + SIP_DELAY_MINUTES;
  return weekend || barDate < newYorkDate(now) || sipSettled;
}

async function writeRunStart(
  targetSql: NeonSql,
  runId: string,
  startedAt: string,
): Promise<void> {
  await targetSql`
    INSERT INTO pipeline_run_log
      (id, pipeline, dry_run, session, items_total, items_ai, models, items,
       summary, host, status, coverage)
    VALUES
      (${runId}::uuid, 'hydrate-universe', false, ${runId}, 0, 0,
       '{}'::jsonb, '[]'::jsonb,
       ${JSON.stringify({ phase: "running", startedAt })}::jsonb,
       'gcp', 'partial', '{}'::jsonb)
  `;
}

async function writeRunFinish(
  targetSql: NeonSql,
  runId: string,
  items: RunItem[],
  summary: Record<string, unknown>,
  status: "ok" | "partial" | "fail",
): Promise<void> {
  await targetSql`
    UPDATE pipeline_run_log
       SET items_total = ${items.length},
           items = ${JSON.stringify(items)}::jsonb,
           summary = ${JSON.stringify(summary)}::jsonb,
           status = ${status},
           coverage = ${JSON.stringify({
             expected: summary.expectedCards,
             filled: summary.cardsAccepted,
           })}::jsonb
     WHERE id = ${runId}::uuid
  `;
}

async function main(): Promise<void> {
  const sourceUrl = requiredEnv("SOURCE_DATABASE_URL");
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && process.env.ENABLE_HYDRATION_WRITES !== "true") {
    throw new Error("Set ENABLE_HYDRATION_WRITES=true only after approving the hydration target");
  }
  const targetUrl = process.env.HYDRATION_DATABASE_URL?.trim() ?? "";
  if (!dryRun || targetUrl) {
    if (!targetUrl) throw new Error("HYDRATION_DATABASE_URL is required for database writes");
    assertHydrationTarget(sourceUrl, targetUrl);
  }

  const apiKey = requiredEnv("ALPACA_API_KEY");
  const apiSecret = requiredEnv("ALPACA_API_SECRET");
  const sourceSql = neon(sourceUrl);
  const targetSql = targetUrl ? neon(targetUrl) : null;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const startedClock = Date.now();
  const items: RunItem[] = [];
  let cardsWritten = 0;
  let cardsAccepted = 0;
  let unservable = 0;
  let failed = 0;
  let runRecorded = false;

  try {
    if (!dryRun && targetSql) await writeRunStart(targetSql, runId, startedAt);
    const activeRows = await sourceSql`
      SELECT ticker, universe, name
        FROM ticker_universe
       WHERE active = true
       ORDER BY ticker
    ` as UniverseRow[];
    const symbolLimit = process.argv.find((argument) => argument.startsWith("--limit="));
    const limit = symbolLimit ? Number(symbolLimit.slice("--limit=".length)) : null;
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error("--limit must be a positive integer");
    }
    const universe = limit === null ? activeRows : activeRows.slice(0, limit);
    if (universe.length === 0) throw new Error("Production ticker_universe returned no active symbols");
    if (!dryRun && targetSql) await upsertUniverse(targetSql, universe);
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - LOOKBACK_DAYS);
    const startDate = newYorkDate(start);
    const endDate = sipHistoryEnd(now, SIP_DELAY_MINUTES);
    const observedAt = now.toISOString();

    for (const symbolBatch of chunks(universe, FETCH_CHUNK_SIZE)) {
      const bars = await fetchBars(
        symbolBatch.map((row) => row.ticker),
        startDate,
        endDate,
        apiKey,
        apiSecret,
      );
      const cardWrites: CardWrite[] = [];

      for (const entry of symbolBatch) {
        const symbolBars = bars.get(entry.ticker) ?? [];
        let row: ComputedRow | null;
        try {
          row = computeRow(entry.ticker, entry.universe, symbolBars);
        } catch {
          failed += 1;
          items.push({ subject: entry.ticker, model: null, outcome: "fail" });
          continue;
        }
        if (!row) {
          unservable += 1;
          items.push({ subject: entry.ticker, model: null, outcome: "skip" });
          continue;
        }
        if (row.frameStats.barCount < MIN_BARS) {
          failed += 1;
          items.push({ subject: entry.ticker, model: null, outcome: "fail" });
          continue;
        }

        const input = {
          rsi: row.rsi,
          ...(row.macdCross === undefined ? {} : { macdCross: row.macdCross }),
          adx: row.adx,
          volatilityPercentile: row.volatilityPercentile,
          confluenceScore: row.confluenceScore,
          direction: row.direction,
        };
        for (const horizon of ["t1", "t2"] as const) {
          const card = buildCard(entry.ticker, entry.universe, input, horizon, row.frameStats);
          cardWrites.push({
            ticker: card.ticker,
            horizon: card.horizon,
            universe: card.universe,
            state_key: card.stateKey,
            taxonomy_version: card.taxonomyVersion,
            score: card.score,
            score_version: card.scoreVersion,
            action: card.action,
            tokens: card.tokens,
            numerics: {},
            data_quality: card.dataQuality,
            missing_fields: card.missingFields,
            source: HYDRATION_SOURCE,
            source_run_id: runId,
            bar_date: row.barDate,
            is_final: isFinalBar(now, row.barDate),
            observed_at: observedAt,
          });
        }
        items.push({ subject: entry.ticker, model: null, outcome: "ok" });
      }

      if (cardWrites.length > 0) {
        if (!dryRun && targetSql) {
          const outcome = await upsertCards(targetSql, cardWrites);
          cardsWritten += outcome.written;
          cardsAccepted += outcome.accepted;
        } else {
          // A dry run computes eligible cards without writing them. Count those
          // as accepted for coverage, while keeping `written` at zero.
          cardsAccepted += cardWrites.length;
        }
      }
    }

    const expected = universe.length;
    const serviceable = expected - unservable;
    const coverage = serviceable === 0 ? 0 : (serviceable - failed) / serviceable;
    const unservableExceeded = !unservableWithinCeiling(unservable, expected);
    const status = coverage < MIN_COVERAGE_RATIO || unservableExceeded
      ? "fail"
      : failed > 0
        ? "partial"
        : "ok";
    const summary = {
      runId,
      source: HYDRATION_SOURCE,
      startedAt,
      finishedAt: new Date().toISOString(),
      expected,
      written: cardsWritten,
      expectedCards: expected * 2,
      cardsAccepted,
      alpacaRequests,
      unservable,
      failed,
      coverage,
      isFinal: isFinalBar(now, newYorkDate(now)),
      durationMs: Date.now() - startedClock,
      dryRun,
    };
    if (!dryRun && targetSql) {
      await writeRunFinish(targetSql, runId, items, summary, status);
      runRecorded = true;
    }
    console.log(JSON.stringify(summary));
    if (status === "fail") throw new Error("Hydration coverage fell below the configured minimum");
  } catch (error) {
    // A coverage failure throws after the detailed record is written; keep it
    // rather than replacing it with the bare failure marker.
    if (!dryRun && targetSql && !runRecorded) {
      try {
        await writeRunFinish(
          targetSql,
          runId,
          items,
          { runId, startedAt, failedAt: new Date().toISOString(), failed: true },
          "fail",
        );
      } catch {
        // Cloud Run logs remain the fallback if the branch itself is unavailable.
      }
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown hydration failure";
    console.error(`hydration job failed: ${message}`);
    process.exitCode = 1;
  });
}
