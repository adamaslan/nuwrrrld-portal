import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_FORMAT_VERSION,
  INCREMENTAL_TABLES,
  OVERLAP_MS,
  exportTable,
  planIncremental,
  readMeta,
  schemaSha256,
  writeManifest,
} from "../scripts/backup-incremental.mjs";

// node:sqlite needs Node 22+. CI's unit job runs Node 20 (vitest.config.ts),
// so the SQLite-backed cases skip there instead of crashing the file.
const sqlite = await import("node:sqlite").catch(() => null);
// The repo's @types/node predates node:sqlite's options/get() typings.
interface Stmt { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }
interface Db { exec(sql: string): void; prepare(sql: string): Stmt; close(): void }
const DatabaseSync = sqlite?.DatabaseSync as unknown as new (path: string, opts?: { readOnly?: boolean }) => Db;

const SCHEMA_SQL = readFileSync(join(__dirname, "..", "lib", "db", "schema.sqlite.sql"), "utf8");
const SCHEMA_SHA = schemaSha256(SCHEMA_SQL);
// daily_bars is the delta table; news_articles + news_article_symbols cover
// a full-every-run parent/child pair with a real FK.
const TABLES = ["daily_bars", "news_article_symbols", "news_articles"] as const;
const TICKERS = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, "0")}`);

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T12:00:00.000Z");

/** A SQLite DB built from the mirror schema stands in for Postgres. */
function makeSource(): Db {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF;");
  const bar = db.prepare(
    `INSERT INTO daily_bars (ticker, bar_date, open, high, low, close, volume, feed, adjustment, source, fetched_at)
     VALUES (?, ?, 1, 2, 0.5, 1.5, 1000, 'sip', 'split', 'alpaca', ?)`,
  );
  // 300 sessions x 20 tickers = 6,000 historical bars, each fetched the day of.
  for (let d = 0; d < 300; d++) {
    const date = iso(Date.parse("2025-09-01T00:00:00Z") + d * DAY).slice(0, 10);
    const fetched = iso(T0 - (300 - d) * DAY);
    for (const t of TICKERS) bar.run(t, date, fetched);
  }
  addArticle(db, 1, T0 - 2 * DAY);
  addArticle(db, 2, T0 - DAY);
  return db;
}

function addArticle(db: Db, id: number, atMs: number) {
  db.prepare(
    `INSERT INTO news_articles (article_id, provider, source, headline, created_at, updated_at, ingested_at, simhash, corroborated)
     VALUES (?, 'alpaca', 'wire', ?, ?, ?, ?, 7, 0)`,
  ).run(id, `headline ${id}`, iso(atMs), iso(atMs), iso(atMs));
  db.prepare(
    `INSERT INTO news_article_symbols (article_id, ticker, symbols_count, relevance, story_id, novelty)
     VALUES (?, 'T00', 1, 0.5, 's', 0.5)`,
  ).run(id);
}

/** One new session bar per ticker plus `corrections` re-fetched old bars. */
function simulateNight(db: Db, nightMs: number, corrections: number) {
  const date = iso(nightMs).slice(0, 10);
  const ins = db.prepare(
    `INSERT INTO daily_bars (ticker, bar_date, open, high, low, close, volume, feed, adjustment, source, fetched_at)
     VALUES (?, ?, 3, 4, 2, 3.5, 2000, 'sip', 'split', 'alpaca', ?)`,
  );
  for (const t of TICKERS) ins.run(t, date, iso(nightMs));
  db.prepare(
    `UPDATE daily_bars SET close = close + 1, fetched_at = ?
     WHERE rowid IN (SELECT rowid FROM daily_bars WHERE bar_date < ? ORDER BY bar_date DESC LIMIT ?)`,
  ).run(iso(nightMs), date, corrections);
}

interface Meter { queries: number; rows: number; bytes: number }

/** Postgres-shaped query fn over the SQLite source, metered. */
function metered(source: Db, meter: Meter, failOnCall?: number) {
  return async (text: string, params: unknown[]) => {
    meter.queries += 1;
    if (failOnCall !== undefined && meter.queries === failOnCall) throw new Error("connection reset");
    const rows = source.prepare(text.replace(/\$(\d+)/g, "?$1")).all(...(params as never[])) as Record<string, unknown>[];
    meter.rows += rows.length;
    meter.bytes += Buffer.byteLength(JSON.stringify(rows));
    return rows;
  };
}

function pgColumnsOf(source: Db, table: string) {
  return (source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string; pk: number }[]).map(
    (c) => ({
      column_name: c.name,
      data_type: c.type === "REAL" ? "double precision" : c.type === "INTEGER" ? "integer" : "text",
    }),
  );
}

function pkOf(source: Db, table: string) {
  return (source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

/** Mirrors backup-to-sqlite.mjs main(): schema, FK off, exportTable per table, manifest. */
async function backup(
  source: Db,
  outPath: string,
  opts: { capturedAt: string; base?: string; chunkRows?: number; meter?: Meter },
) {
  const meter = opts.meter ?? { queries: 0, rows: 0, bytes: 0 };
  let plan: { since: string; baseCapturedAt: string } | null = null;
  if (opts.base) {
    const b = new DatabaseSync(opts.base, { readOnly: true });
    plan = planIncremental(readMeta(b), SCHEMA_SHA);
    b.close();
  }
  const db = new DatabaseSync(outPath);
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF;");
  const entries: Parameters<typeof writeManifest>[2] = [];
  for (const table of TABLES) {
    entries.push(
      await exportTable(metered(source, meter), db, {
        table,
        pgColumns: pgColumnsOf(source, table),
        pkColumns: pkOf(source, table),
        chunkRows: opts.chunkRows ?? 10_000,
        since: plan?.since ?? null,
      }),
    );
  }
  writeManifest(
    db,
    {
      kind: plan ? "incremental" : "full",
      captured_at: opts.capturedAt,
      format_version: BACKUP_FORMAT_VERSION,
      schema_sha256: SCHEMA_SHA,
      filtered: "0",
      ...(plan ? { since: plan.since, base_captured_at: plan.baseCapturedAt } : {}),
    },
    entries,
  );
  db.close();
  return { meter, entries };
}

function dump(db: Db, table: string) {
  const pk = pkOf(db, table).map((c) => `"${c}"`).join(", ");
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${pk}`).all();
}

describe("planIncremental", () => {
  const base = {
    kind: "full",
    captured_at: "2026-11-25T11:59:11.000Z",
    format_version: BACKUP_FORMAT_VERSION,
    schema_sha256: "abc",
  };

  it("starts the delta OVERLAP_MS before the base's database-clock capture", () => {
    const plan = planIncremental(base, "abc");
    expect(Date.parse(base.captured_at) - Date.parse(plan.since)).toBe(OVERLAP_MS);
    expect(plan.baseCapturedAt).toBe(base.captured_at);
  });

  it("refuses a base from before incremental support (no metadata)", () => {
    expect(() => planIncremental({}, "abc")).toThrow(/take a full backup first/);
  });

  it("refuses when the SQLite schema changed since the base", () => {
    expect(() => planIncremental(base, "different")).toThrow(/schema change/);
  });

  it("only allows tables whose every write stamps the watermark", () => {
    expect(INCREMENTAL_TABLES).toEqual({ daily_bars: "fetched_at" });
  });
});

describe.skipIf(!sqlite)("incremental backup + restore on synthetic data", () => {
  let dir: string;
  let source: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nwf-backup-"));
    source = makeSource();
  });
  afterEach(() => {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads only changed daily_bars rows: before/after query count, rows, bytes on the same data", async () => {
    await backup(source, join(dir, "full0.sqlite"), { capturedAt: iso(T0) });
    simulateNight(source, T0 + DAY - 3 * 60 * 60 * 1000, 3);

    const full = await backup(source, join(dir, "full1.sqlite"), { capturedAt: iso(T0 + DAY) });
    const inc = await backup(source, join(dir, "inc1.sqlite"), {
      capturedAt: iso(T0 + DAY),
      base: join(dir, "full0.sqlite"),
    });

    const fullBars = full.entries.find((e) => e.table === "daily_bars")!;
    const incBars = inc.entries.find((e) => e.table === "daily_bars")!;
    expect(fullBars).toMatchObject({ mode: "full", rows: 6_020 });
    // 20 new session bars + 3 corrected old bars; nothing else was touched.
    expect(incBars).toMatchObject({ mode: "delta", rows: 23, sourceCount: 6_020 });

    console.log(
      `[backup fixture] full: ${full.meter.queries} queries, ${full.meter.rows} rows, ${full.meter.bytes} JSON bytes | ` +
      `incremental: ${inc.meter.queries} queries, ${inc.meter.rows} rows, ${inc.meter.bytes} JSON bytes`,
    );
    expect(inc.meter.rows).toBeLessThan(full.meter.rows / 50);
    expect(inc.meter.bytes).toBeLessThan(full.meter.bytes / 50);
    // One extra count(*) for the delta table, nothing more.
    expect(inc.meter.queries).toBe(full.meter.queries + 1);
  });

  it("restores full + incrementals to exactly the state a fresh full backup sees", async () => {
    await backup(source, join(dir, "b0.sqlite"), { capturedAt: iso(T0) });
    simulateNight(source, T0 + DAY - 3 * 60 * 60 * 1000, 5);
    addArticle(source, 3, T0 + DAY - 60_000);
    await backup(source, join(dir, "b1.sqlite"), { capturedAt: iso(T0 + DAY), base: join(dir, "b0.sqlite") });
    simulateNight(source, T0 + 2 * DAY - 3 * 60 * 60 * 1000, 2);
    source.prepare("UPDATE news_articles SET corroborated = 1 WHERE article_id = 1").run();
    await backup(source, join(dir, "b2.sqlite"), {
      capturedAt: iso(T0 + 2 * DAY),
      base: join(dir, "b1.sqlite"),
      chunkRows: 7, // force multi-chunk keyset paging on the delta
    });
    await backup(source, join(dir, "truth.sqlite"), { capturedAt: iso(T0 + 2 * DAY) });

    const { restoreChain } = await import("../scripts/backup-restore.mjs");
    const counts = restoreChain(
      [join(dir, "b0.sqlite"), join(dir, "b1.sqlite"), join(dir, "b2.sqlite")],
      join(dir, "restored.sqlite"),
    );
    expect(counts).toEqual({ daily_bars: 6_040, news_article_symbols: 3, news_articles: 3 });

    const restored = new DatabaseSync(join(dir, "restored.sqlite"), { readOnly: true });
    const truth = new DatabaseSync(join(dir, "truth.sqlite"), { readOnly: true });
    for (const t of TABLES) expect(dump(restored, t)).toEqual(dump(truth, t));
    expect(readMeta(restored)).toMatchObject({ kind: "restored", captured_at: iso(T0 + 2 * DAY), chain_length: "3" });
    restored.close();
    truth.close();
  });

  it("picks up a late-committed row stamped before the base capture (overlap window)", async () => {
    await backup(source, join(dir, "b0.sqlite"), { capturedAt: iso(T0) });
    // Transaction began 1h before the base read daily_bars, committed after it.
    source
      .prepare(
        `INSERT INTO daily_bars (ticker, bar_date, open, high, low, close, volume, feed, adjustment, source, fetched_at)
         VALUES ('LATE', '2026-10-31', 1, 1, 1, 1, 1, 'sip', 'split', 'alpaca', ?)`,
      )
      .run(iso(T0 - 60 * 60 * 1000));
    await backup(source, join(dir, "b1.sqlite"), { capturedAt: iso(T0 + DAY), base: join(dir, "b0.sqlite") });
    const { restoreChain } = await import("../scripts/backup-restore.mjs");
    restoreChain([join(dir, "b0.sqlite"), join(dir, "b1.sqlite")], join(dir, "r.sqlite"));
    const r = new DatabaseSync(join(dir, "r.sqlite"), { readOnly: true });
    expect(r.prepare("SELECT count(*) AS n FROM daily_bars WHERE ticker = 'LATE'").get()).toEqual({ n: 1 });
    r.close();
  });

  it("fails restore loudly when a delta table lost rows (delete not visible in a delta)", async () => {
    await backup(source, join(dir, "b0.sqlite"), { capturedAt: iso(T0) });
    source.prepare("DELETE FROM daily_bars WHERE ticker = 'T05' AND bar_date = '2025-09-01'").run();
    await backup(source, join(dir, "b1.sqlite"), { capturedAt: iso(T0 + DAY), base: join(dir, "b0.sqlite") });
    const { restoreChain } = await import("../scripts/backup-restore.mjs");
    expect(() => restoreChain([join(dir, "b0.sqlite"), join(dir, "b1.sqlite")], join(dir, "r.sqlite"))).toThrow(
      /deleted since the base.*take a full backup/,
    );
  });

  it("refuses a chain with a missing link instead of restoring around the gap", async () => {
    await backup(source, join(dir, "b0.sqlite"), { capturedAt: iso(T0) });
    simulateNight(source, T0 + DAY - 3 * 60 * 60 * 1000, 0);
    await backup(source, join(dir, "b1.sqlite"), { capturedAt: iso(T0 + DAY), base: join(dir, "b0.sqlite") });
    simulateNight(source, T0 + 2 * DAY - 3 * 60 * 60 * 1000, 0);
    await backup(source, join(dir, "b2.sqlite"), { capturedAt: iso(T0 + 2 * DAY), base: join(dir, "b1.sqlite") });
    const { restoreChain } = await import("../scripts/backup-restore.mjs");
    expect(() => restoreChain([join(dir, "b0.sqlite"), join(dir, "b2.sqlite")], join(dir, "r.sqlite"))).toThrow(
      /link is missing or out of order/,
    );
    expect(() => restoreChain([join(dir, "b1.sqlite")], join(dir, "r2.sqlite"))).toThrow(/must be a full backup/);
  });

  it("refuses a chain whose schema changed between links", async () => {
    const { validateChain } = await import("../scripts/backup-restore.mjs");
    const meta = { format_version: BACKUP_FORMAT_VERSION, filtered: "0" };
    expect(() =>
      validateChain([
        { path: "a", meta: { ...meta, kind: "full", captured_at: "t0", schema_sha256: "x" }, manifest: {} },
        { path: "b", meta: { ...meta, kind: "incremental", base_captured_at: "t0", schema_sha256: "y" }, manifest: {} },
      ]),
    ).toThrow(/schema changed/);
  });

  it("an interrupted delta read leaves no partial rows in the backup", async () => {
    await backup(source, join(dir, "b0.sqlite"), { capturedAt: iso(T0) });
    simulateNight(source, T0 + DAY - 3 * 60 * 60 * 1000, 0);
    const out = new DatabaseSync(join(dir, "b1.sqlite"));
    out.exec(SCHEMA_SQL);
    const meter = { queries: 0, rows: 0, bytes: 0 };
    await expect(
      exportTable(metered(source, meter, 3), out, {
        table: "daily_bars",
        pgColumns: pgColumnsOf(source, "daily_bars"),
        pkColumns: pkOf(source, "daily_bars"),
        chunkRows: 5,
        since: iso(T0 - OVERLAP_MS),
      }),
    ).rejects.toThrow(/connection reset/);
    expect(out.prepare("SELECT count(*) AS n FROM daily_bars").get()).toEqual({ n: 0 });
    out.close();
  });
});

// Tripwire for the INCREMENTAL_TABLES safety argument: if daily_bars' writer
// stops stamping fetched_at, or anything starts deleting from it, a delta
// would silently miss changes. Fail here so the allowlist gets re-decided.
describe("daily_bars write-path invariants behind the delta watermark", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

  it("upsertBars stamps fetched_at on every conflict update", () => {
    const src = read("lib/engine-db.ts");
    const upsert = src.slice(src.indexOf("export async function upsertBars"), src.indexOf("export async function latestBarDates"));
    expect(upsert).toMatch(/INSERT INTO daily_bars/);
    expect(upsert).toMatch(/ON CONFLICT[\s\S]*fetched_at\s*=\s*now\(\)/);
  });

  it("no app or lib code deletes or truncates daily_bars", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs|py|sql)$/.test(f) ? [p] : [];
      });
    const root = join(__dirname, "..");
    const offenders = ["app", "lib", "scripts", "deploy"]
      .flatMap((d) => walk(join(root, d)))
      .filter((p) => /(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+daily_bars\b/i.test(readFileSync(p, "utf8")));
    expect(offenders).toEqual([]);
  });
});
