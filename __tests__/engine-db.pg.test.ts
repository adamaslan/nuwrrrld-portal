import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Integration test for lib/engine-db.ts against a real local Postgres.
 * Skipped unless ENGINE_PG_PORT is set (mamba env `pg-test`; see harness
 * ENGINE-PROGRESS.md step A). Neon's driver cannot talk to a local server, so
 * `@/lib/db` is replaced by a shim that inlines parameters as literals and
 * runs the statement through psql — enough to prove the SQL is valid and the
 * upserts are idempotent, not to prove Neon's parameter typing.
 */
const PORT = process.env.ENGINE_PG_PORT;
/** Absolute path to the pg-test env's psql (`mamba run -n pg-test which psql`); mamba run per statement is too slow. */
const PSQL = process.env.ENGINE_PSQL ?? "psql";

function literal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `ARRAY[${v.map(literal).join(",")}]`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function run(query: string): unknown[] {
  const wrapped = /^\s*select/i.test(query) ? `SELECT coalesce(json_agg(t), '[]')::jsonb::text FROM (${query}) t` : query;
  const out = spawnSync(
    PSQL,
    ["-h", "localhost", "-p", PORT!, "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", wrapped],
    { encoding: "utf8" },
  );
  if (out.status !== 0) throw new Error(`psql failed: ${out.stderr}\n${query.slice(0, 400)}`);
  return /^\s*select/i.test(query) ? JSON.parse(out.stdout.trim().split("\n")[0]) : [];
}

/** Statements of the last sql.transaction, so a test can replay them in one session. */
const lastTransaction: string[] = [];

vi.mock("@/lib/db", () => {
  // Lazy like Neon's queries: runs when awaited, or as part of sql.transaction.
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? literal(values[i]) : ""), "");
    return { text, then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve().then(() => run(text)).then(ok, err) };
  };
  tag.transaction = async (queries: Array<{ text: string }>) => {
    lastTransaction.splice(0, lastTransaction.length, ...queries.map((q) => q.text));
    run(`BEGIN;\n${queries.map((q) => `${q.text};`).join("\n")}\nCOMMIT;`);
    return queries.map(() => []);
  };
  return { default: tag };
});

describe.skipIf(!PORT)("engine-db against local Postgres", { timeout: 60_000 }, () => {
  let db: typeof import("@/lib/engine-db");
  beforeAll(async () => {
    db = await import("@/lib/engine-db");
    run("DELETE FROM engine_forward_returns WHERE hit_id IN (SELECT id FROM engine_detector_hits WHERE ticker LIKE 'ZZ%')");
    for (const table of ["engine_detector_hits", "engine_structure", "daily_bars"]) {
      run(`DELETE FROM ${table} WHERE ticker LIKE 'ZZ%'`);
    }
    run("DELETE FROM engine_runs WHERE id = 'zz-run'");
    run("DELETE FROM ticker_universe WHERE ticker LIKE 'ZZ%'");
  });

  const rows = Array.from({ length: 5 }, (_, i) => ({
    ticker: "ZZTEST",
    barDate: `2026-09-${String(21 + i).padStart(2, "0")}`,
    open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volume: 1000,
  }));

  it("upserts bars idempotently and reports the latest date per feed", async () => {
    await db.upsertBars(rows, { feed: "iex", adjustment: "split", source: "test" });
    await db.upsertBars(rows, { feed: "iex", adjustment: "split", source: "test" });
    const series = await db.loadSeries(["ZZTEST"], "iex", 300);
    expect(series[0].bars).toHaveLength(5);
    expect(series[0].dates[4]).toBe("2026-09-25");
    expect((await db.latestBarDates()).iex).toBeTruthy();
  });

  it("writes a run, structure and hits, and a rewrite keeps the hit id", async () => {
    await db.startRun("zz-run", { codeVersion: "test@0", mode: "shadow", feed: "iex" });
    const snapshot = {
      close: 15, atr: 1.5, legs: [{ low: 1, high: 2, isUp: true, endIndex: 3 }], levels: [{ name: "Fib 0.618", price: 14, distance_pct: -6, strength: "strong", type: "retracement" as const }],
      zones: [], nearestSupport: 14, nearestResistance: null, swingAnchor: "confirmed_pivots" as const, swingDirection: "up" as const,
      hits: [], degraded: false, warnings: [],
    };
    const meta = { codeVersion: "test@0", runId: "zz-run" };
    await db.writeSnapshots([{ ticker: "ZZTEST", barDate: "2026-09-25", snapshot }], meta);
    const hit = { ticker: "ZZTEST", barDate: "2026-09-25", detector: "fibonacci", signal: "FIB GOLDEN POCKET HOLD", category: "FIBONACCI", strength: "STRONG BULLISH", description: "d", experimental: false, features: { stop: 13, target: 20 } };
    await db.writeHits([hit], meta);
    const first = run("SELECT id FROM engine_detector_hits WHERE ticker='ZZTEST'") as Array<{ id: string }>;
    await db.writeHits([{ ...hit, features: { stop: 13.5, target: 20 } }], meta);
    const second = run("SELECT id, features FROM engine_detector_hits WHERE ticker='ZZTEST'") as Array<{ id: string; features: { stop: number } }>;
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].features.stop).toBe(13.5);
    await db.bumpRun("zz-run", { ok: 1, skipped: 0, failed: 0, degraded: 0, hits: 1, barDate: "2026-09-25" });
    expect((await db.latestStructure("ZZTEST"))?.nearest_support).toBe(14);
  });

  it("labels a hit once enough later bars exist, and only once", async () => {
    const later = Array.from({ length: 21 }, (_, i) => ({
      ticker: "ZZTEST", barDate: new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10),
      open: 15, high: 16, low: 14.5, close: 15.5, volume: 1000,
    }));
    await db.upsertBars(later, { feed: "iex", adjustment: "split", source: "test" });
    const pending = (await db.pendingHits(21, 50)).filter((h) => h.ticker === "ZZTEST");
    expect(pending).toHaveLength(1);
    expect(pending[0].stop).toBe(13.5);
    expect(pending[0].feed).toBe("iex");
    expect(pending[0].side).toBe(1);
    const future = await db.barsAfter("ZZTEST", pending[0].feed, pending[0].barDate, 21);
    expect(future).toHaveLength(21);
    const { labelHit } = await import("@/lib/engine");
    const label = labelHit({ entry: pending[0].entry, stop: pending[0].stop, target: pending[0].target, futureBars: future })!;
    expect(await db.writeLabels([{ hitId: pending[0].id, label }])).toBe(1);
    await db.writeLabels([{ hitId: pending[0].id, label }]);
    expect((await db.pendingHits(21, 50)).filter((h) => h.ticker === "ZZTEST")).toHaveLength(0);
  });

  it("counts later bars in the hit's own feed, labels only directional hits, and reads the side", async () => {
    const meta = { codeVersion: "test@0", runId: "zz-run" };
    const snapshot = {
      close: 15, atr: 1.5, legs: [], levels: [], zones: [], nearestSupport: null, nearestResistance: null,
      swingAnchor: "confirmed_pivots" as const, swingDirection: "up" as const, hits: [], degraded: false, warnings: [],
    };
    const mk = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({
      ticker: "ZZTWO", barDate: new Date(Date.UTC(2026, 8, from + i)).toISOString().slice(0, 10),
      open: 15, high: 16, low: 14.5, close: 15.5, volume: 1000,
    }));
    await db.upsertBars(mk(5, 21), { feed: "iex", adjustment: "split", source: "test" });
    await db.writeSnapshots([{ ticker: "ZZTWO", barDate: "2026-09-25", snapshot }], meta);
    const hit = { ticker: "ZZTWO", barDate: "2026-09-25", detector: "fibonacci", category: "FIBONACCI", description: "d", experimental: true, features: {} };
    await db.writeHits([
      { ...hit, signal: "FIB 0.786 BREAK", strength: "BEARISH" },
      { ...hit, signal: "FIB CONFLUENCE ZONE", strength: "SIGNIFICANT" },
    ], meta);

    // The sip feed alone has 21 later bars; the hit's own feed (iex) has none. The old count
    // spanned feeds, so this hit was returned first every run and could never be labeled.
    await db.upsertBars(mk(21, 26), { feed: "sip", adjustment: "split", source: "test" });
    // A sip bar on the hit date with a very different close must not become the entry.
    await db.upsertBars([{ ...mk(1, 25)[0], close: 99 }], { feed: "sip", adjustment: "split", source: "test" });
    expect((await db.pendingHits(21, 50)).filter((h) => h.ticker === "ZZTWO")).toHaveLength(0);

    await db.upsertBars(mk(21, 26), { feed: "iex", adjustment: "split", source: "test" });
    const pending = (await db.pendingHits(21, 50)).filter((h) => h.ticker === "ZZTWO");
    expect(pending).toHaveLength(1); // SIGNIFICANT has no direction, so it is never a label candidate
    // Entry is the iex bar's close (15.5), not engine_structure's close (15) and not the sip bar (99).
    expect(pending[0]).toMatchObject({ feed: "iex", side: -1, entry: 15.5 });
    expect(await db.barsAfter("ZZTWO", "iex", pending[0].barDate, 21)).toHaveLength(21);
  });

  it("labelDiagnostics buckets every unlabeled hit by cause", async () => {
    const before = await db.labelDiagnostics(21);
    const bars = (ticker: string, n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        ticker,
        barDate: new Date(Date.UTC(2026, 8, from + i)).toISOString().slice(0, 10),
        open: 15, high: 16, low: 14.5, close: 15.5, volume: 1000,
      }));
    // ZZDIAG1: entry bar plus only 5 later iex bars — not yet labelable.
    await db.upsertBars(bars("ZZDIAG1", 6, 25), { feed: "iex", adjustment: "split", source: "test" });
    const hit = { barDate: "2026-09-25", detector: "fibonacci", category: "FIBONACCI", description: "d", experimental: true, features: {} };
    await db.writeHits([
      { ...hit, ticker: "ZZDIAG1", signal: "FIB 0.786 BREAK", strength: "BEARISH" },
      // ZZDIAG3: a run row exists but no entry bar is stored for the hit date.
      { ...hit, ticker: "ZZDIAG3", signal: "FIB 0.786 BREAK", strength: "STRONG BEARISH" },
      // ZZDIAG4: SIGNIFICANT states no direction — never a label candidate.
      { ...hit, ticker: "ZZDIAG4", signal: "FIB 1.618 TARGET", strength: "SIGNIFICANT" },
    ], { codeVersion: "test@0", runId: "zz-run" });
    // ZZDIAG2: run_id names no engine_runs row, so the pendingHits join drops it.
    await db.writeHits([{ ...hit, ticker: "ZZDIAG2", signal: "FIB 0.786 BREAK", strength: "BULLISH" }], { codeVersion: "test@0", runId: "zz-missing" });

    const after = await db.labelDiagnostics(21);
    expect(after.unlabeledDirectional - before.unlabeledDirectional).toBe(3);
    expect(after.awaitingBars - before.awaitingBars).toBe(1);
    expect(after.missingEntryBar - before.missingEntryBar).toBe(1);
    expect(after.noRunRow - before.noRunRow).toBe(1);
    expect(after.ready - before.ready).toBe(0);
    expect(after.unlabeledNonDirectional - before.unlabeledNonDirectional).toBe(1);
    expect((after.byFeed["iex"] ?? 0) - (before.byFeed["iex"] ?? 0)).toBe(2);
    expect((after.byFeed["(no run)"] ?? 0) - (before.byFeed["(no run)"] ?? 0)).toBe(1);
    // The buckets agree with pendingHits: none of the four is a label candidate.
    const pending = await db.pendingHits(21, 500);
    expect(pending.filter((h) => h.ticker.startsWith("ZZDIAG"))).toHaveLength(0);
  });

  it("pages the active universe by offset and limit", async () => {
    run("INSERT INTO ticker_universe (ticker, universe, active) VALUES ('ZZA','stock',true),('ZZB','stock',true),('ZZC','stock',false) ON CONFLICT DO NOTHING");
    const before = await db.countEngineTickers();
    const all = await db.listEngineTickers(0, 10_000);
    expect(all).toHaveLength(before);
    expect(all).toContain("ZZA");
    expect(all).not.toContain("ZZC");
    const idx = all.indexOf("ZZA");
    expect(await db.listEngineTickers(idx, 2)).toEqual(all.slice(idx, idx + 2));
  });
});

describe.skipIf(!PORT)("coveringRun watermark against local Postgres", { timeout: 60_000 }, () => {
  let db: typeof import("@/lib/engine-db");
  // Own feed and code version so other tests' bars and runs never match.
  const FEED = "zzf" as unknown as import("@/lib/shared/engine-bars").BarFeed;
  const CV = "zz-engine@1";
  const meta = { feed: FEED, adjustment: "split" as const, source: "test" };
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const bars = (closeShift = 0) => Array.from({ length: 5 }, (_, i) => ({
    ticker: "ZZW", barDate: `2026-11-${String(17 + i).padStart(2, "0")}`,
    open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i + closeShift, volume: 1000,
  }));
  const activeCount = () => (run("SELECT count(*)::int AS n FROM ticker_universe WHERE active") as Array<{ n: number }>)[0].n;
  /** A run row as engine-run's chunks leave it: started now, bumped per chunk. */
  async function finishRun(id: string, opts: { codeVersion?: string; mode?: "shadow" | "live"; covered?: number; failed?: number; complete?: boolean } = {}) {
    await db.startRun(id, { codeVersion: opts.codeVersion ?? CV, mode: opts.mode ?? "shadow", feed: FEED });
    const n = opts.covered ?? activeCount();
    const failed = opts.failed ?? 0;
    await db.bumpRun(id, { ok: n - failed - 1, skipped: 1, failed, degraded: 0, hits: 3, barDate: "2026-11-21" });
    if (opts.complete !== false) await db.markRunComplete(id);
  }
  const fetchedAt = () => (run("SELECT extract(epoch FROM max(fetched_at))::float8 AS ts FROM daily_bars WHERE feed = 'zzf'") as Array<{ ts: number }>)[0].ts;

  beforeAll(async () => {
    db = await import("@/lib/engine-db");
    run("DELETE FROM daily_bars WHERE feed = 'zzf'");
    run("DELETE FROM engine_runs WHERE id LIKE 'zzw-%'");
    run("DELETE FROM ticker_universe WHERE ticker IN ('ZZW2', 'ZZW3')");
    run("INSERT INTO ticker_universe (ticker, universe, active) VALUES ('ZZW','stock',true) ON CONFLICT (ticker) DO UPDATE SET active = true");
  });
  const reset = () => run("DELETE FROM engine_runs WHERE id LIKE 'zzw-%'");

  it("an unchanged refetch leaves fetched_at alone; a changed value or new bar moves it", async () => {
    await db.upsertBars(bars(), meta);
    const first = fetchedAt();
    await tick();
    await db.upsertBars(bars(), meta); // engine-bars refetches its trailing overlap every run
    expect(fetchedAt()).toBe(first);
    await tick();
    await db.upsertBars([{ ...bars()[4], close: 99 }], meta);
    expect(fetchedAt() > first).toBe(true);
    expect((await db.loadSeries(["ZZW"], FEED, 300))[0].bars[4].close).toBe(99);
    await db.upsertBars(bars(), meta); // restore
  });

  // Every non-key column upsertBars writes must count as a change, or a revised
  // bar would keep its old fetched_at and both coveringRun and the backup delta
  // (which reads fetched_at) would miss it.
  it.each([
    ["open", { open: 50 }, {}],
    ["high", { high: 50 }, {}],
    ["low", { low: 1 }, {}],
    ["close", { close: 50 }, {}],
    ["volume", { volume: 7 }, {}],
    ["adjustment", {}, { adjustment: "raw" as const }],
    ["source", {}, { source: "test-revised" }],
  ])("a change to %s alone moves fetched_at and is stored", async (column, rowChange, metaChange) => {
    const base = { ...bars()[0], barDate: "2026-11-10" };
    await db.upsertBars([base], meta);
    const before = (run("SELECT extract(epoch FROM fetched_at)::float8 AS ts FROM daily_bars WHERE feed = 'zzf' AND bar_date = '2026-11-10'") as Array<{ ts: number }>)[0].ts;
    await tick();
    await db.upsertBars([{ ...base, ...rowChange }], { ...meta, ...metaChange });
    const after = (run(`SELECT extract(epoch FROM fetched_at)::float8 AS ts, ${column} AS v FROM daily_bars WHERE feed = 'zzf' AND bar_date = '2026-11-10'`) as Array<{ ts: number; v: unknown }>)[0];
    expect(after.ts).toBeGreaterThan(before);
    expect(after.v).toBe({ ...rowChange, ...metaChange }[column as never]);
    run("DELETE FROM daily_bars WHERE feed = 'zzf' AND bar_date = '2026-11-10'");
  });

  it("bounds each bar upsert with a transaction-local statement_timeout that does not outlive it", async () => {
    await db.upsertBars([{ ...bars()[0], barDate: "2026-11-11" }], meta);
    expect(lastTransaction[0]).toMatch(/^SET LOCAL statement_timeout = '5min'$/);
    expect(lastTransaction[1]).toMatch(/^\s*INSERT INTO daily_bars/);
    // Replay the same statements in one session: 5min inside, the server default after COMMIT.
    const out = spawnSync(PSQL, ["-h", "localhost", "-p", PORT!, "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      encoding: "utf8",
      input: `SHOW statement_timeout;\nBEGIN;\n${lastTransaction[0]};\nSHOW statement_timeout;\n${lastTransaction[1]};\nCOMMIT;\nSHOW statement_timeout;\n`,
    });
    expect(out.status).toBe(0);
    const shown = out.stdout.split("\n").filter((l) => /^\d|^\d+min$/.test(l));
    expect(shown).toEqual(["0", "5min", "0"]);
    run("DELETE FROM daily_bars WHERE feed = 'zzf' AND bar_date = '2026-11-11'");
  });

  it("fails open with no run, then covers once a finished run started after the newest bar change", async () => {
    reset();
    await tick();
    expect(await db.coveringRun(FEED, CV)).toBeNull(); // no earlier run
    await finishRun("zzw-a");
    expect(await db.coveringRun(FEED, CV)).toEqual({ id: "zzw-a", barDate: "2026-11-21" });
  });

  it("late midday cron: an identical refetch after a finished run still counts as covered", async () => {
    reset();
    await tick();
    await finishRun("zzw-a");
    await tick();
    await db.upsertBars(bars(), meta);
    expect((await db.coveringRun(FEED, CV))?.id).toBe("zzw-a");
  });

  it("a new or revised bar after the run means recompute (late data)", async () => {
    reset();
    await tick();
    await finishRun("zzw-a");
    await tick();
    await db.upsertBars([{ ...bars()[4], barDate: "2026-11-24" }], meta);
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    await tick();
    await finishRun("zzw-b");
    expect((await db.coveringRun(FEED, CV))?.id).toBe("zzw-b");
    await tick();
    await db.upsertBars([{ ...bars()[2], volume: 1234 }], meta); // revised older bar inside the overlap
    expect(await db.coveringRun(FEED, CV)).toBeNull();
  });

  it("a partial run, a run with failed tickers, or a ticker-count mismatch means recompute", async () => {
    reset();
    await tick();
    const n = activeCount();
    await finishRun("zzw-partial", { covered: n - 1, complete: false }); // a chunk never reported back
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    await finishRun("zzw-short", { covered: n - 1 }); // last chunk called alone: complete, but short
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    run("UPDATE ticker_universe SET active = false WHERE ticker = 'ZZW'"); // count now matches the short runs
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    run("UPDATE ticker_universe SET active = true WHERE ticker = 'ZZW'");
    await db.startRun("zzw-started", { codeVersion: CV, mode: "shadow", feed: FEED }); // died before any chunk
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    await finishRun("zzw-failed", { failed: 1 });
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    await finishRun("zzw-full");
    expect((await db.coveringRun(FEED, CV))?.id).toBe("zzw-full");
    run("UPDATE ticker_universe SET active = false WHERE ticker = 'ZZW'"); // universe shrank
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    run("UPDATE ticker_universe SET active = true WHERE ticker = 'ZZW'");
    expect((await db.coveringRun(FEED, CV))?.id).toBe("zzw-full"); // same active set as the run
    run("INSERT INTO ticker_universe (ticker, universe, active) VALUES ('ZZW2','stock',true) ON CONFLICT (ticker) DO NOTHING");
    run("UPDATE ticker_universe SET active = false WHERE ticker = 'ZZW'"); // swap: same count, different set
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    run("DELETE FROM ticker_universe WHERE ticker = 'ZZW2'");
    run("UPDATE ticker_universe SET active = true WHERE ticker = 'ZZW'");
  });

  it("a universe change mid-run never lets that run become complete", async () => {
    reset();
    await tick();
    await db.startRun("zzw-mid", { codeVersion: CV, mode: "shadow", feed: FEED });
    run("INSERT INTO ticker_universe (ticker, universe, active) VALUES ('ZZW3','stock',true) ON CONFLICT (ticker) DO NOTHING");
    await db.bumpRun("zzw-mid", { ok: activeCount(), skipped: 0, failed: 0, degraded: 0, hits: 0, barDate: "2026-11-21" });
    await db.markRunComplete("zzw-mid");
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    run("DELETE FROM ticker_universe WHERE ticker = 'ZZW3'");
  });

  it("a different code version or a live run never covers a shadow run", async () => {
    reset();
    await tick();
    await finishRun("zzw-old", { codeVersion: "zz-engine@0" });
    await finishRun("zzw-live", { mode: "live" });
    expect(await db.coveringRun(FEED, CV)).toBeNull();
  });

  it("overlapping runs: an unfinished run never covers, and bars written after a run started void it", async () => {
    reset();
    await tick();
    await db.startRun("zzw-a", { codeVersion: CV, mode: "shadow", feed: FEED });
    await db.bumpRun("zzw-a", { ok: 1, skipped: 0, failed: 0, degraded: 0, hits: 0, barDate: "2026-11-21" });
    // Run B starts while A has reported only one chunk.
    expect(await db.coveringRun(FEED, CV)).toBeNull();
    await tick();
    await db.upsertBars([{ ...bars()[4], barDate: "2026-11-25" }], meta); // bars land mid-run
    await db.bumpRun("zzw-a", { ok: activeCount() - 1, skipped: 0, failed: 0, degraded: 0, hits: 0, barDate: "2026-11-21" });
    await db.markRunComplete("zzw-a");
    expect(await db.coveringRun(FEED, CV)).toBeNull(); // A finished, but started before the change
  });
});
