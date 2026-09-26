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

vi.mock("@/lib/db", () => ({
  default: (strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(run(strings.reduce((acc, s, i) => acc + s + (i < values.length ? literal(values[i]) : ""), ""))),
}));

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
    const future = await db.barsAfter("ZZTEST", pending[0].barDate, 21);
    expect(future).toHaveLength(21);
    const { labelHit } = await import("@/lib/engine");
    const label = labelHit({ entry: pending[0].entry, stop: pending[0].stop, target: pending[0].target, futureBars: future })!;
    expect(await db.writeLabels([{ hitId: pending[0].id, label }])).toBe(1);
    await db.writeLabels([{ hitId: pending[0].id, label }]);
    expect((await db.pendingHits(21, 50)).filter((h) => h.ticker === "ZZTEST")).toHaveLength(0);
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
