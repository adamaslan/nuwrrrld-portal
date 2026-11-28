import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_FORMAT_VERSION,
  INCREMENTAL_TABLES,
  OVERLAP_MS,
  captureToMeta,
  exportTable,
  partialPath,
  planIncremental,
  publishPartial,
  readMeta,
  schemaSha256,
  validateArtifact,
  writeManifest,
} from "../scripts/backup-incremental.mjs";

// node:sqlite needs Node 22+. CI's unit job runs Node 20 (vitest.config.ts),
// so the SQLite-backed cases skip there instead of crashing the file.
const sqlite = await import("node:sqlite").catch(() => null);
// The repo's @types/node predates node:sqlite's options/get() typings.
interface Stmt { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown; run(...p: unknown[]): unknown }
interface Db { exec(sql: string): void; prepare(sql: string): Stmt; close(): void }
const DatabaseSync = sqlite?.DatabaseSync as unknown as new (path: string, opts?: { readOnly?: boolean }) => Db;

const ROOT = join(__dirname, "..");
const SCHEMA_SQL = readFileSync(join(ROOT, "lib", "db", "schema.sqlite.sql"), "utf8");
const SCHEMA_SHA = schemaSha256(SCHEMA_SQL);
// daily_bars is the delta table; news_articles + news_article_symbols cover
// a full-every-run parent/child pair with a real FK.
const TABLES = ["daily_bars", "news_article_symbols", "news_articles"] as const;
const TICKERS = Array.from({ length: 20 }, (_, i) => `T${String(i).padStart(2, "0")}`);

const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-01T12:00:00.000Z");

const BAR_SQL = `INSERT INTO daily_bars (ticker, bar_date, open, high, low, close, volume, feed, adjustment, source, fetched_at)
  VALUES (?, ?, 1, 2, 0.5, 1.5, 1000, 'sip', 'split', 'alpaca', ?)`;

/**
 * A file-backed SQLite DB in WAL mode stands in for Postgres. A second
 * connection (`reader`) gives the snapshot transaction real isolation from
 * the writer, the way a REPEATABLE READ read is isolated in Postgres.
 */
function makeSource(dir: string): { writer: Db; reader: Db } {
  const path = join(dir, "source.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec("PRAGMA journal_mode = WAL;");
  writer.exec(SCHEMA_SQL);
  writer.exec("PRAGMA foreign_keys = OFF;");
  writer.exec("BEGIN");
  const bar = writer.prepare(BAR_SQL);
  // 300 sessions x 20 tickers = 6,000 historical bars, each fetched the day of.
  for (let d = 0; d < 300; d++) {
    const date = iso(Date.parse("2025-09-01T00:00:00Z") + d * DAY).slice(0, 10);
    for (const t of TICKERS) bar.run(t, date, iso(T0 - (300 - d) * DAY));
  }
  writer.exec("COMMIT");
  addArticle(writer, 1, T0 - 2 * DAY);
  addArticle(writer, 2, T0 - DAY);
  return { writer, reader: new DatabaseSync(path) };
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
  const ins = db.prepare(BAR_SQL);
  for (const t of TICKERS) ins.run(t, date, iso(nightMs));
  db.prepare(
    `UPDATE daily_bars SET close = close + 1, fetched_at = ?
     WHERE rowid IN (SELECT rowid FROM daily_bars WHERE bar_date < ? ORDER BY bar_date DESC LIMIT ?)`,
  ).run(iso(nightMs), date, corrections);
}

interface Meter { statements: number; requests: number; rows: number; bytes: number }
const newMeter = (): Meter => ({ statements: 0, requests: 0, rows: 0, bytes: 0 });
const pg = (text: string) => text.replace(/\$(\d+)/g, "?$1");

function record(meter: Meter, rows: unknown[]) {
  meter.statements += 1;
  meter.rows += rows.length;
  meter.bytes += Buffer.byteLength(JSON.stringify(rows));
}

/** Postgres-shaped query fn over the source: one request per statement. */
function metered(source: Db, meter: Meter) {
  return async (text: string, params: unknown[]) => {
    meter.requests += 1;
    const rows = source.prepare(pg(text)).all(...(params as never[])) as Record<string, unknown>[];
    record(meter, rows);
    return rows;
  };
}

/** sql.transaction stand-in: one request, one isolated read transaction. */
function snapshotOn(reader: Db, meter: Meter, opts: { afterStatement?: (i: number) => void; fail?: Error } = {}) {
  return async (stmts: { text: string; params: unknown[] }[]) => {
    meter.requests += 1;
    if (opts.fail) throw opts.fail;
    reader.exec("BEGIN");
    try {
      const out = stmts.map((s, i) => {
        const rows = reader.prepare(pg(s.text)).all(...(s.params as never[])) as Record<string, unknown>[];
        record(meter, rows);
        opts.afterStatement?.(i);
        return rows;
      });
      reader.exec("COMMIT");
      return out;
    } catch (err) {
      reader.exec("ROLLBACK");
      throw err;
    }
  };
}

function pgColumnsOf(source: Db, table: string) {
  return (source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[]).map((c) => ({
    column_name: c.name,
    data_type: c.type === "REAL" ? "double precision" : c.type === "INTEGER" ? "integer" : "text",
  }));
}

function pkOf(source: Db, table: string) {
  return (source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

interface ClockOpts { capturedAt: string; oldestOpen?: string | null; invisible?: number }
const captureStmt = (c: ClockOpts) => ({
  text: "SELECT ? AS now, ? AS oldest_open_xact_at, ? AS invisible_sessions",
  params: [c.capturedAt, c.oldestOpen ?? null, c.invisible ?? 0],
});

/** Mirrors backup-to-sqlite.mjs main(): private file, export, manifest, validate, publish. */
async function backup(
  src: { writer: Db; reader: Db },
  outPath: string,
  opts: ClockOpts & { base?: string; chunkRows?: number; afterStatement?: (i: number) => void },
) {
  const meter = newMeter();
  let plan: { since: string; baseCapturedAt: string } | null = null;
  if (opts.base) {
    const b = new DatabaseSync(opts.base, { readOnly: true });
    try {
      plan = planIncremental(validateArtifact(b, opts.base), SCHEMA_SHA);
    } finally {
      b.close();
    }
  }
  const tmp = partialPath(outPath);
  const db = new DatabaseSync(tmp);
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = OFF;");
  let capture = captureToMeta({ now: opts.capturedAt, oldest_open_xact_at: opts.oldestOpen ?? null, invisible_sessions: opts.invisible ?? 0 });
  const entries: Parameters<typeof writeManifest>[2] = [];
  for (const table of TABLES) {
    const entry = await exportTable(metered(src.writer, meter), db, {
      table,
      pgColumns: pgColumnsOf(src.writer, table),
      pkColumns: pkOf(src.writer, table),
      chunkRows: opts.chunkRows ?? 10_000,
      since: plan?.since ?? null,
      snapshot: snapshotOn(src.reader, meter, { afterStatement: opts.afterStatement }),
      capture: captureStmt(opts),
    });
    if (entry.capture) capture = captureToMeta(entry.capture);
    delete entry.capture;
    entries.push(entry);
  }
  writeManifest(
    db,
    {
      kind: plan ? "incremental" : "full",
      ...capture,
      format_version: BACKUP_FORMAT_VERSION,
      schema_sha256: SCHEMA_SHA,
      filtered: "0",
      ...(plan ? { since: plan.since, base_captured_at: plan.baseCapturedAt } : {}),
    },
    entries,
  );
  validateArtifact(db, tmp);
  publishPartial(db, tmp, outPath);
  return { meter, entries, plan };
}

function dump(db: Db, table: string) {
  const pk = pkOf(db, table).map((c) => `"${c}"`).join(", ");
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${pk}`).all();
}

const restore = async (paths: string[], out: string) => (await import("../scripts/backup-restore.mjs")).restoreChain(paths, out);

describe("planIncremental", () => {
  const meta = {
    kind: "full",
    captured_at: "2026-11-25T11:59:11.000Z",
    format_version: BACKUP_FORMAT_VERSION,
    schema_sha256: "abc",
  };

  it("starts the delta OVERLAP_MS before the base's database-clock capture", () => {
    const plan = planIncremental({ meta, manifest: {} }, "abc");
    expect(Date.parse(meta.captured_at) - Date.parse(plan.since)).toBe(OVERLAP_MS);
    expect(plan.baseCapturedAt).toBe(meta.captured_at);
  });

  it("reaches back to the oldest open transaction the base saw, when older than the overlap", () => {
    const oldest = "2026-11-24T20:00:00.000Z";
    expect(planIncremental({ meta: { ...meta, oldest_open_xact_at: oldest }, manifest: {} }, "abc").since).toBe(oldest);
  });

  it("refuses when the SQLite schema changed since the base", () => {
    expect(() => planIncremental({ meta, manifest: {} }, "different")).toThrow(/schema change/);
  });

  it("only allows tables whose every write stamps the watermark", () => {
    expect(INCREMENTAL_TABLES).toEqual({ daily_bars: "fetched_at" });
  });
});

describe.skipIf(!sqlite)("incremental backup + restore on synthetic data", () => {
  let dir: string;
  let src: { writer: Db; reader: Db };
  const p = (name: string) => join(dir, name);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nwf-backup-"));
    src = makeSource(dir);
  });
  afterEach(() => {
    src.writer.close();
    src.reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads only changed daily_bars rows: before/after statements, requests, rows, bytes on the same data", async () => {
    await backup(src, p("full0.sqlite"), { capturedAt: iso(T0) });
    simulateNight(src.writer, T0 + DAY - 3 * HOUR, 3);

    const full = await backup(src, p("full1.sqlite"), { capturedAt: iso(T0 + DAY) });
    const inc = await backup(src, p("inc1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("full0.sqlite") });

    expect(full.entries.find((e) => e.table === "daily_bars")).toMatchObject({ mode: "full", rows: 6_020 });
    // 20 new session bars + 3 corrected old bars; nothing else was touched.
    expect(inc.entries.find((e) => e.table === "daily_bars")).toMatchObject({ mode: "delta", rows: 23, sourceCount: 6_020 });

    console.log(
      `[backup fixture] full: ${full.meter.statements} statements / ${full.meter.requests} requests, ` +
      `${full.meter.rows} rows, ${full.meter.bytes} JSON bytes | incremental: ${inc.meter.statements} statements / ` +
      `${inc.meter.requests} requests, ${inc.meter.rows} rows, ${inc.meter.bytes} JSON bytes`,
    );
    expect(inc.meter.rows).toBeLessThan(full.meter.rows / 50);
    expect(inc.meter.bytes).toBeLessThan(full.meter.bytes / 50);
    // The delta table is one request either way; it adds the clock and count.
    expect(inc.meter.requests).toBe(full.meter.requests);
    expect(inc.meter.statements).toBe(full.meter.statements + 2);
  });

  it("restores full + incrementals to exactly the state a fresh full backup sees", async () => {
    await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
    simulateNight(src.writer, T0 + DAY - 3 * HOUR, 5);
    addArticle(src.writer, 3, T0 + DAY - 60_000);
    await backup(src, p("b1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("b0.sqlite") });
    simulateNight(src.writer, T0 + 2 * DAY - 3 * HOUR, 2);
    src.writer.prepare("UPDATE news_articles SET corroborated = 1 WHERE article_id = 1").run();
    await backup(src, p("b2.sqlite"), { capturedAt: iso(T0 + 2 * DAY), base: p("b1.sqlite"), chunkRows: 7 });
    await backup(src, p("truth.sqlite"), { capturedAt: iso(T0 + 2 * DAY) });

    const counts = await restore([p("b0.sqlite"), p("b1.sqlite"), p("b2.sqlite")], p("restored.sqlite"));
    expect(counts).toEqual({ daily_bars: 6_040, news_article_symbols: 3, news_articles: 3 });

    const restored = new DatabaseSync(p("restored.sqlite"), { readOnly: true });
    const truth = new DatabaseSync(p("truth.sqlite"), { readOnly: true });
    for (const t of TABLES) expect(dump(restored, t)).toEqual(dump(truth, t));
    expect(readMeta(restored)).toMatchObject({
      kind: "restored",
      captured_at: iso(T0 + 2 * DAY),
      chain_length: "3",
      late_commit_guarantee: "observed",
    });
    restored.close();
    truth.close();
    expect(existsSync(partialPath(p("restored.sqlite")))).toBe(false);
  });

  it("a write committed between the delta read and the count cannot break the link (one snapshot)", async () => {
    await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
    // Review repro: insert a bar right before the count query runs.
    await backup(src, p("b1.sqlite"), {
      capturedAt: iso(T0 + DAY),
      base: p("b0.sqlite"),
      afterStatement: (i) => {
        if (i === 1) src.writer.prepare(BAR_SQL).run("RACE", "2026-11-01", iso(T0 + DAY + 1_000));
      },
    });
    const b1 = new DatabaseSync(p("b1.sqlite"), { readOnly: true });
    // Delta and count agree: the concurrent row is in neither.
    expect(validateArtifact(b1).manifest.daily_bars).toMatchObject({ rows: 0, source_count: 6_000 });
    b1.close();
    await restore([p("b0.sqlite"), p("b1.sqlite")], p("r1.sqlite"));
    // The next link picks it up.
    await backup(src, p("b2.sqlite"), { capturedAt: iso(T0 + 2 * DAY), base: p("b1.sqlite") });
    expect((await restore([p("b0.sqlite"), p("b1.sqlite"), p("b2.sqlite")], p("r2.sqlite"))).daily_bars).toBe(6_001);
  });

  it("picks up a late-committed row stamped inside the overlap window", async () => {
    await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
    // Transaction began 1h before the base read daily_bars, committed after it.
    src.writer.prepare(BAR_SQL).run("LATE", "2026-10-31", iso(T0 - HOUR));
    await backup(src, p("b1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("b0.sqlite") });
    await restore([p("b0.sqlite"), p("b1.sqlite")], p("r.sqlite"));
    const r = new DatabaseSync(p("r.sqlite"), { readOnly: true });
    expect(r.prepare("SELECT count(*) AS n FROM daily_bars WHERE ticker = 'LATE'").get()).toEqual({ n: 1 });
    r.close();
  });

  describe("a late in-place correction stamped just before the overlap window", () => {
    const correct = () =>
      src.writer
        .prepare("UPDATE daily_bars SET close = 99, fetched_at = ? WHERE ticker = 'T07' AND bar_date = '2025-09-01'")
        .run(iso(T0 - OVERLAP_MS - 1));
    const closeOf = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare("SELECT close FROM daily_bars WHERE ticker = 'T07' AND bar_date = '2025-09-01'").get();
      db.close();
      return (row as { close: number }).close;
    };

    it("is caught when the base saw that writer's open transaction", async () => {
      await backup(src, p("b0.sqlite"), { capturedAt: iso(T0), oldestOpen: iso(T0 - OVERLAP_MS - 1) });
      correct();
      await backup(src, p("b1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("b0.sqlite") });
      await restore([p("b0.sqlite"), p("b1.sqlite")], p("r.sqlite"));
      expect(closeOf(p("r.sqlite"))).toBe(99);
    });

    it("is a labelled known limit when the base could not see every session, and the next full repairs it", async () => {
      await backup(src, p("b0.sqlite"), { capturedAt: iso(T0), invisible: 1 });
      correct();
      await backup(src, p("b1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("b0.sqlite") });
      await restore([p("b0.sqlite"), p("b1.sqlite")], p("r.sqlite"));
      expect(closeOf(p("r.sqlite"))).toBe(1.5); // stale, and labelled so:
      const r = new DatabaseSync(p("r.sqlite"), { readOnly: true });
      expect(readMeta(r).late_commit_guarantee).toBe("overlap-only");
      r.close();
      await backup(src, p("full.sqlite"), { capturedAt: iso(T0 + 2 * DAY) });
      expect(closeOf(p("full.sqlite"))).toBe(99);
    });
  });

  it("names deleted-at-source rows as stale and short counts as missing", async () => {
    await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
    src.writer.prepare("DELETE FROM daily_bars WHERE ticker = 'T05' AND bar_date = '2025-09-01'").run();
    await backup(src, p("b1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("b0.sqlite") });
    await expect(restore([p("b0.sqlite"), p("b1.sqlite")], p("r.sqlite"))).rejects.toThrow(
      /1 stale row\(s\) deleted at the source.*take a full backup/,
    );
    // A link whose live count exceeds what the chain can rebuild is "missing".
    const b1 = new DatabaseSync(p("b1.sqlite"));
    b1.prepare("UPDATE _backup_manifest SET source_count = 6002 WHERE table_name = 'daily_bars'").run();
    b1.close();
    await expect(restore([p("b0.sqlite"), p("b1.sqlite")], p("r2.sqlite"))).rejects.toThrow(/2 row\(s\) missing/);
    expect(existsSync(p("r.sqlite")) || existsSync(p("r2.sqlite"))).toBe(false);
  });

  it("refuses a chain with a missing link, or one that does not start with a full", async () => {
    await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
    simulateNight(src.writer, T0 + DAY - 3 * HOUR, 0);
    await backup(src, p("b1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("b0.sqlite") });
    simulateNight(src.writer, T0 + 2 * DAY - 3 * HOUR, 0);
    await backup(src, p("b2.sqlite"), { capturedAt: iso(T0 + 2 * DAY), base: p("b1.sqlite") });
    await expect(restore([p("b0.sqlite"), p("b2.sqlite")], p("r.sqlite"))).rejects.toThrow(/link is missing or out of order/);
    await expect(restore([p("b1.sqlite")], p("r2.sqlite"))).rejects.toThrow(/must be a full backup/);
  });

  describe("validateArtifact re-derives what the metadata claims", () => {
    beforeEach(async () => {
      await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
    });
    const tamper = (sql: string) => {
      const db = new DatabaseSync(p("b0.sqlite"));
      db.exec(sql);
      db.close();
    };
    const check = () => {
      const db = new DatabaseSync(p("b0.sqlite"), { readOnly: true });
      try {
        return validateArtifact(db, "b0");
      } finally {
        db.close();
      }
    };

    it("accepts an untouched backup", () => {
      expect(check().meta.kind).toBe("full");
    });
    it("rejects actual rows that differ from the manifest", () => {
      tamper("PRAGMA foreign_keys = OFF; DELETE FROM news_articles WHERE article_id = 2");
      expect(check).toThrow(/holds 1 rows but the manifest declares 2/);
    });
    it("rejects a manifest that is missing a table with rows", () => {
      tamper("DELETE FROM _backup_manifest WHERE table_name = 'news_articles'");
      expect(check).toThrow(/"news_articles" has rows but is missing from the manifest/);
    });
    it("rejects a changed table layout even when the declared schema hash matches", () => {
      tamper("ALTER TABLE daily_bars ADD COLUMN extra TEXT");
      expect(check).toThrow(/shape hash/);
    });
    it("rejects a filtered backup as a base or link", () => {
      tamper("UPDATE _backup_meta SET value = '1' WHERE key = 'filtered'");
      expect(check).toThrow(/filtered/);
    });
    it("rejects a pre-metadata (legacy) backup", () => {
      tamper("DROP TABLE _backup_meta");
      expect(check).toThrow(/take a full backup first/);
    });
    it("rejects a delta entry without a live source count", async () => {
      await backup(src, p("b1.sqlite"), { capturedAt: iso(T0 + DAY), base: p("b0.sqlite") });
      const db = new DatabaseSync(p("b1.sqlite"));
      db.exec("UPDATE _backup_manifest SET source_count = NULL WHERE table_name = 'daily_bars'");
      expect(() => validateArtifact(db, "b1")).toThrow(/no live source count/);
      db.close();
    });
  });

  it("a failed delta snapshot leaves no partial rows, and a too-large delta asks for a full", async () => {
    const out = new DatabaseSync(p("x.sqlite"));
    out.exec(SCHEMA_SQL);
    const opts = {
      table: "daily_bars",
      pgColumns: pgColumnsOf(src.writer, "daily_bars"),
      pkColumns: pkOf(src.writer, "daily_bars"),
      since: iso(T0 - OVERLAP_MS),
      capture: captureStmt({ capturedAt: iso(T0) }),
    };
    const meter = newMeter();
    await expect(
      exportTable(metered(src.writer, meter), out, { ...opts, snapshot: snapshotOn(src.reader, meter, { fail: new Error("connection reset") }) }),
    ).rejects.toThrow(/connection reset/);
    await expect(
      exportTable(metered(src.writer, meter), out, {
        ...opts,
        snapshot: snapshotOn(src.reader, meter, { fail: new Error("response is too large (max is 67108864 bytes)") }),
      }),
    ).rejects.toThrow(/take a full backup/);
    expect(out.prepare("SELECT count(*) AS n FROM daily_bars").get()).toEqual({ n: 0 });
    out.close();
  });

  it("an abrupt kill while writing metadata publishes nothing and leaves no usable checkpoint", () => {
    const out = p("killed.sqlite");
    const tmp = partialPath(out);
    const harness = p("harness.mjs");
    writeFileSync(
      harness,
      `import { DatabaseSync } from "node:sqlite";
       import { writeManifest } from ${JSON.stringify(join(ROOT, "scripts", "backup-incremental.mjs"))};
       const db = new DatabaseSync(${JSON.stringify(tmp)});
       db.exec("PRAGMA journal_mode = WAL;");
       db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
       db.exec("INSERT INTO t VALUES (1), (2)");
       const killer = { get table() { process.kill(process.pid, "SIGKILL"); return "never"; }, mode: "full", rows: 0 };
       writeManifest(db, { kind: "full", captured_at: "2026-11-01T00:00:00.000Z", format_version: "${BACKUP_FORMAT_VERSION}", filtered: "0" },
         [{ table: "t", mode: "full", rows: 2 }, killer]);`,
    );
    const res = spawnSync(process.execPath, [harness], { encoding: "utf8" });
    expect(res.signal).toBe("SIGKILL");
    expect(existsSync(out)).toBe(false);
    const db = new DatabaseSync(tmp, { readOnly: true });
    expect(readMeta(db)).toEqual({}); // the metadata transaction never committed
    expect(() => validateArtifact(db, tmp)).toThrow(/take a full backup first/);
    db.close();
  });

  it("publishing never overwrites an existing backup", () => {
    writeFileSync(p("taken.sqlite"), "previous good backup");
    const db = new DatabaseSync(partialPath(p("taken.sqlite")));
    db.exec("CREATE TABLE t (id INTEGER)");
    expect(() => publishPartial(db, partialPath(p("taken.sqlite")), p("taken.sqlite"))).toThrow(/EEXIST/);
    expect(readFileSync(p("taken.sqlite"), "utf8")).toBe("previous good backup");
  });
});

// Tripwire for the INCREMENTAL_TABLES safety argument: if daily_bars' writer
// stops stamping fetched_at, or anything starts deleting from it, a delta
// would silently miss changes. Fail here so the allowlist gets re-decided.
describe("daily_bars write-path invariants behind the delta watermark", () => {
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

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
        if (f.startsWith(".") || f === "node_modules" || f === "__pycache__") return [];
        const full = join(dir, f);
        return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|mjs|py|sql)$/.test(f) ? [full] : [];
      });
    const offenders = ["app", "lib", "scripts", "deploy"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => /(DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+daily_bars\b/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  }, 30_000);
});
