import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKUP_FORMAT_VERSION,
  INCREMENTAL_TABLES,
  OVERLAP_MS,
  PG_CAPTURE_SQL,
  captureToMeta,
  completeInventory,
  dataTables,
  provenAbsentTables,
  createStaging,
  discardStaging,
  exportTable,
  floorCaptures,
  manifestSha256,
  planIncremental,
  publishStaged,
  readManifest,
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
  writer.exec("PRAGMA synchronous = OFF;"); // fixture only; no durability needed
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

interface ClockOpts {
  capturedAt: string;
  oldestOpen?: string | null;
  invisible?: number;
  // The pg_stat_activity sample taken just before a delta snapshot. Defaults
  // to 1s before capturedAt with the same visibility as the in-snapshot one.
  pre?: { capturedAt?: string; oldestOpen?: string | null; invisible?: number };
}
const CAPTURE_SQL = "SELECT ? AS now, ? AS oldest_open_xact_at, ? AS invisible_sessions";
const captureStmt = (c: ClockOpts) => ({ text: CAPTURE_SQL, params: [c.capturedAt, c.oldestOpen ?? null, c.invisible ?? 0] });
const preCaptureStmt = (c: ClockOpts) => ({
  text: CAPTURE_SQL,
  params: [
    c.pre?.capturedAt ?? iso(Date.parse(c.capturedAt) - 1_000),
    c.pre && "oldestOpen" in c.pre ? c.pre.oldestOpen ?? null : c.oldestOpen ?? null,
    c.pre?.invisible ?? c.invisible ?? 0,
  ],
});

/** Mirrors backup-to-sqlite.mjs main(): private file, export, manifest, validate, publish. */
async function backup(
  src: { writer: Db; reader: Db },
  outPath: string,
  opts: ClockOpts & { base?: string; chunkRows?: number; afterStatement?: (i: number) => void },
) {
  const meter = newMeter();
  let plan: { since: string; baseCapturedAt: string; parentArtifactId?: string } | null = null;
  if (opts.base) {
    const b = new DatabaseSync(opts.base, { readOnly: true });
    try {
      plan = planIncremental(validateArtifact(b, opts.base), SCHEMA_SHA);
    } finally {
      b.close();
    }
  }
  const staging = createStaging(outPath);
  const db = new DatabaseSync(staging.path);
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
      preCapture: preCaptureStmt(opts),
    });
    if (entry.capture) capture = floorCaptures(entry.capture, capture);
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
      ...(plan ? { since: plan.since, base_captured_at: plan.baseCapturedAt, parent_artifact_id: plan.parentArtifactId } : {}),
    },
    completeInventory(db, entries, new Set(), new Set(dataTables(db).filter((t) => !(TABLES as readonly string[]).includes(t)))),
  );
  try {
    validateArtifact(db, staging.path);
    publishStaged(db, staging, outPath);
  } catch (err) {
    try { db.close(); } catch { /* already closed */ }
    discardStaging(staging);
    throw err;
  }
  return { meter, entries, plan };
}

function dump(db: Db, table: string) {
  const pk = pkOf(db, table).map((c) => `"${c}"`).join(", ");
  return db.prepare(`SELECT * FROM "${table}" ORDER BY ${pk}`).all();
}

const restore = async (paths: string[], out: string) => (await import("../scripts/backup-restore.mjs")).restoreChain(paths, out);

/** Edit a published file and re-sign its manifest digest, so a test reaches
 * the specific check behind the digest (an attacker-free "honest bug"). */
function editAndResign(path: string, sql: string) {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.prepare("UPDATE _backup_meta SET value = ? WHERE key = 'manifest_sha256'").run(manifestSha256(Object.values(readManifest(db as never))));
  db.close();
}

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

  it("floorCaptures keeps earlier observations: their oldest open xact and their sample time", () => {
    const anchor = { captured_at: "2026-11-25T12:00:00.000Z", oldest_open_xact_at: null, late_commit_bound: "observed" };
    const pre = { captured_at: "2026-11-25T11:59:59.000Z", oldest_open_xact_at: "2026-11-25T03:00:00.000Z", late_commit_bound: "observed" };
    expect(floorCaptures(anchor, pre)).toEqual({ ...anchor, oldest_open_xact_at: pre.oldest_open_xact_at });
    expect(floorCaptures(anchor, { ...pre, oldest_open_xact_at: null }).oldest_open_xact_at).toBe(pre.captured_at);
    expect(floorCaptures(anchor, { ...pre, late_commit_bound: "overlap-only" }).late_commit_bound).toBe("overlap-only");
  });

  it("only allows tables whose every write stamps the watermark", () => {
    expect(INCREMENTAL_TABLES).toEqual({ daily_bars: "fetched_at" });
  });
});

// File-backed fixtures run several full exports per case; allow for a loaded machine.
describe.skipIf(!sqlite)("incremental backup + restore on synthetic data", { timeout: 30_000 }, () => {
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
    // The delta adds a pre-snapshot activity sample (one request) and, inside
    // the snapshot request, the clock and the count.
    expect(inc.meter.requests).toBe(full.meter.requests + 1);
    expect(inc.meter.statements).toBe(full.meter.statements + 3);
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
    expect(counts).toMatchObject({ daily_bars: 6_040, news_article_symbols: 3, news_articles: 3 });

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
    expect(readdirSync(dir).filter((f) => f.includes(".staging-"))).toEqual([]);
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
    editAndResign(p("b1.sqlite"), "UPDATE _backup_manifest SET source_count = 6002 WHERE table_name = 'daily_bars'");
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
      expect(check).toThrow(/news_articles missing from the manifest/);
    });
    it("rejects an emptied table whose manifest entry was removed (review r2 #3), even when re-signed", () => {
      // Codex's fixture: truncate a table and drop its entry. The layout hash
      // still matches, so only the exact inventory catches it.
      tamper("PRAGMA foreign_keys = OFF; DELETE FROM news_article_symbols; DELETE FROM _backup_manifest WHERE table_name = 'news_article_symbols'");
      expect(check).toThrow(/news_article_symbols missing from the manifest/);
      editAndResign(p("b0.sqlite"), "SELECT 1");
      expect(check).toThrow(/news_article_symbols missing from the manifest/);
    });
    it("rejects a zero-row table dropped from the manifest", () => {
      expect(check().manifest.ticker_universe).toMatchObject({ mode: "absent", rows: 0 });
      editAndResign(p("b0.sqlite"), "DELETE FROM _backup_manifest WHERE table_name = 'ticker_universe'");
      expect(check).toThrow(/ticker_universe missing from the manifest/);
    });
    it("rejects any manifest edit that is not re-signed (digest)", () => {
      tamper("UPDATE _backup_manifest SET rows = 0 WHERE table_name = 'ticker_universe' AND rows = 0; UPDATE _backup_manifest SET since = 'x' WHERE table_name = 'news_articles'");
      expect(check).toThrow(/recorded digest/);
    });
    it("rejects a table marked absent that holds rows", () => {
      editAndResign(p("b0.sqlite"), "UPDATE _backup_manifest SET mode = 'absent' WHERE table_name = 'news_articles'");
      expect(check).toThrow(/marked absent from the source but holds 2 rows/);
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
      editAndResign(p("b1.sqlite"), "UPDATE _backup_manifest SET source_count = NULL WHERE table_name = 'daily_bars'");
      const db = new DatabaseSync(p("b1.sqlite"), { readOnly: true });
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
    const tmp = createStaging(out).path;
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
    const staging = createStaging(p("taken.sqlite"));
    const db = new DatabaseSync(staging.path);
    db.exec("CREATE TABLE t (id INTEGER)");
    expect(() => publishStaged(db, staging, p("taken.sqlite"))).toThrow(/EEXIST/);
    expect(readFileSync(p("taken.sqlite"), "utf8")).toBe("previous good backup");
    discardStaging(staging);
  });

  describe("artifact identity (review r5 #2, #3)", () => {
    const closeT07 = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare("SELECT close FROM daily_bars WHERE ticker = 'T07' AND bar_date = '2025-09-01'").get() as { close: number };
      db.close();
      return row.close;
    };
    const setClose = (v: number) =>
      src.writer.prepare("UPDATE daily_bars SET close = ?, fetched_at = ? WHERE ticker = 'T07' AND bar_date = '2025-09-01'").run(v, iso(T0 - 3 * DAY)); // outside every delta window

    it("a different full backup with the same normalised capture time cannot stand in for the parent", async () => {
      // Raw .000123Z and .000456Z both become .000Z through a JS Date.
      const norm = (raw: string) => captureToMeta({ now: raw, oldest_open_xact_at: null, invisible_sessions: 0 }).captured_at;
      expect(norm("2026-11-01T12:00:00.000123Z")).toBe(norm("2026-11-01T12:00:00.000456Z"));

      setClose(10);
      await backup(src, p("a.sqlite"), { capturedAt: iso(T0) });
      setClose(70);
      await backup(src, p("b.sqlite"), { capturedAt: iso(T0) });
      await backup(src, p("deltaOfA.sqlite"), { capturedAt: iso(T0 + DAY), base: p("a.sqlite") });
      // The delta reads no change to this bar, so its parent decides the restored close.
      await restore([p("a.sqlite"), p("deltaOfA.sqlite")], p("ok.sqlite"));
      expect(closeT07(p("ok.sqlite"))).toBe(10);
      await expect(restore([p("b.sqlite"), p("deltaOfA.sqlite")], p("bad.sqlite"))).rejects.toThrow(/artifact|parent/i);
      expect(existsSync(p("bad.sqlite"))).toBe(false);
    });

    it("every backup gets a unique artifact_id even at an identical capture time", async () => {
      await backup(src, p("a.sqlite"), { capturedAt: iso(T0) });
      await backup(src, p("b.sqlite"), { capturedAt: iso(T0) });
      const id = (f: string) => {
        const db = new DatabaseSync(p(f), { readOnly: true });
        try { return readMeta(db).artifact_id; } finally { db.close(); }
      };
      expect(id("a.sqlite")).toMatch(/^[0-9a-f-]{36}$/);
      expect(id("a.sqlite")).not.toBe(id("b.sqlite"));
    });

    it("a format-3 artifact (written before the NULL-handling fixes) is rejected rather than trusted as observed", async () => {
      await backup(src, p("old.sqlite"), { capturedAt: iso(T0) });
      const db = new DatabaseSync(p("old.sqlite"));
      db.prepare("UPDATE _backup_meta SET value = '3' WHERE key = 'format_version'").run();
      db.prepare("DELETE FROM _backup_meta WHERE key = 'artifact_id'").run();
      db.close();
      const check = () => {
        const d = new DatabaseSync(p("old.sqlite"), { readOnly: true });
        try { return validateArtifact(d, "old"); } finally { d.close(); }
      };
      expect(check).toThrow(/unsupported or missing backup format 3/);
      await expect(restore([p("old.sqlite")], p("r.sqlite"))).rejects.toThrow(/format 3/);
    });
  });

  describe("restoreGuarantee labels observed only on positive proof (review r5 design guard)", () => {
    const link = (bound: unknown, format: unknown = BACKUP_FORMAT_VERSION) => ({ meta: { late_commit_bound: bound, format_version: format } });
    it.each([
      ["observed", [link("observed"), link("observed")], "observed"],
      ["overlap-only base", [link("overlap-only"), link("observed")], "overlap-only"],
      ["missing bound on a base", [link(undefined), link("observed")], "overlap-only"],
      ["unrecognised bound on a base", [link("mostly-observed"), link("observed")], "overlap-only"],
      ["old format on a base", [link("observed", "3"), link("observed")], "overlap-only"],
      ["no links at all", [], "overlap-only"],
    ])("%s -> %s", async (_n, links, want) => {
      const { restoreGuarantee } = await import("../scripts/backup-restore.mjs");
      expect(restoreGuarantee(links as never)).toBe(want);
    });
  });

  describe("two invocations targeting the same output (review r2 #1)", () => {
    it("cannot publish each other's staged file: each owns a private staging directory", () => {
      const out = p("same.sqlite");
      // Codex's interleaving: A validates, then B starts an unfinished file,
      // then A publishes. With a shared staging name A published B's file.
      const a = createStaging(out);
      const dbA = new DatabaseSync(a.path);
      dbA.exec("CREATE TABLE who (name TEXT); INSERT INTO who VALUES ('A-validated')");
      const b = createStaging(out);
      expect(b.dir).not.toBe(a.dir);
      const dbB = new DatabaseSync(b.path);
      dbB.exec("CREATE TABLE who (name TEXT); INSERT INTO who VALUES ('B-unfinished')");
      publishStaged(dbA, a, out);
      const pub = new DatabaseSync(out, { readOnly: true });
      expect(pub.prepare("SELECT name FROM who").all()).toEqual([{ name: "A-validated" }]);
      pub.close();
      // B's failure path removes only B's own directory and never the output.
      expect(() => publishStaged(dbB, b, out)).toThrow(/EEXIST/);
      discardStaging(b);
      expect(existsSync(out)).toBe(true);
      expect(readdirSync(dir).filter((f) => f.includes(".staging-"))).toEqual([]);
    });

    it("concurrent full backups to one path: exactly one publishes, and it validates", async () => {
      const out = p("race.sqlite");
      const results = await Promise.allSettled([
        backup(src, out, { capturedAt: iso(T0) }),
        backup(src, out, { capturedAt: iso(T0 + 1) }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(rejected.reason)).toMatch(/EEXIST/);
      const db = new DatabaseSync(out, { readOnly: true });
      expect(validateArtifact(db, out).meta.kind).toBe("full");
      db.close();
      expect(readdirSync(dir).filter((f) => f.includes(".staging-"))).toEqual([]);
    });
  });

  describe("a writer that commits between the data snapshot and the activity sample (review r2 #2)", () => {
    // Correction stamped just before the 6h window of b1's snapshot: its
    // writer was open when the pre-snapshot sample ran, committed after the
    // delta was read (so b1 lacks it) and before the in-snapshot sample (so
    // that sample no longer lists it).
    const stamp = iso(T0 + DAY - OVERLAP_MS - 1);
    const correctMidSnapshot = (i: number) => {
      if (i === 1) {
        src.writer
          .prepare("UPDATE daily_bars SET close = 99, fetched_at = ? WHERE ticker = 'T07' AND bar_date = '2025-09-01'")
          .run(stamp);
      }
    };
    const closeOf = (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      const row = db.prepare("SELECT close FROM daily_bars WHERE ticker = 'T07' AND bar_date = '2025-09-01'").get();
      db.close();
      return (row as { close: number } | undefined)?.close ?? null;
    };

    it("keeps the pre-snapshot sample as a floor, so the next delta recovers the row and stays 'observed'", async () => {
      await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
      await backup(src, p("b1.sqlite"), {
        capturedAt: iso(T0 + DAY),
        oldestOpen: null, // in-snapshot sample: the writer has already gone
        pre: { oldestOpen: stamp }, // pre-snapshot sample: writer still open
        base: p("b0.sqlite"),
        afterStatement: correctMidSnapshot,
      });
      expect(closeOf(p("b1.sqlite"))).toBeNull(); // b1's delta really missed it
      const b1 = new DatabaseSync(p("b1.sqlite"), { readOnly: true });
      expect(readMeta(b1)).toMatchObject({ oldest_open_xact_at: stamp, late_commit_bound: "observed" });
      b1.close();
      await backup(src, p("b2.sqlite"), { capturedAt: iso(T0 + 2 * DAY), base: p("b1.sqlite") });
      await restore([p("b0.sqlite"), p("b1.sqlite"), p("b2.sqlite")], p("r.sqlite"));
      expect(closeOf(p("r.sqlite"))).toBe(99);
      const r = new DatabaseSync(p("r.sqlite"), { readOnly: true });
      expect(readMeta(r).late_commit_guarantee).toBe("observed");
      r.close();
    });

    it("labels the link overlap-only when the pre-snapshot sample could not see every session", async () => {
      await backup(src, p("b0.sqlite"), { capturedAt: iso(T0) });
      await backup(src, p("b1.sqlite"), {
        capturedAt: iso(T0 + DAY),
        oldestOpen: null,
        pre: { oldestOpen: null, invisible: 1 },
        base: p("b0.sqlite"),
        afterStatement: correctMidSnapshot,
      });
      await backup(src, p("b2.sqlite"), { capturedAt: iso(T0 + 2 * DAY), base: p("b1.sqlite") });
      await restore([p("b0.sqlite"), p("b1.sqlite"), p("b2.sqlite")], p("r.sqlite"));
      const r = new DatabaseSync(p("r.sqlite"), { readOnly: true });
      expect(readMeta(r).late_commit_guarantee).toBe("overlap-only"); // the miss is labelled, never "observed"
      r.close();
    });
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

describe.skipIf(!sqlite)("PG_CAPTURE_SQL against PostgreSQL's pg_stat_activity row shapes (review r3 #1)", () => {
  // Run the production statement itself over a SQLite table shaped like
  // pg_stat_activity. Only the three Postgres-only tokens are rewritten.
  const OBSERVER = 100;
  const capture = (rows: [number, string | null, string | null, string | null][]) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE pg_stat_activity (pid INTEGER, backend_type TEXT, state TEXT, xact_start TEXT)");
    const ins = db.prepare("INSERT INTO pg_stat_activity VALUES (?, ?, ?, ?)");
    for (const r of rows) ins.run(...r);
    const sqliteSql = PG_CAPTURE_SQL.replaceAll("pg_backend_pid()", String(OBSERVER)).replaceAll("::int", "").replace("now()", "'t'");
    const row = db.prepare(sqliteSql).get() as { invisible_sessions: number };
    db.close();
    return Number(row.invisible_sessions);
  };

  it("counts a session the role cannot inspect (backend_type, state, xact_start all NULL)", () => {
    expect(capture([[7, null, null, null]])).toBe(1);
    // and it flows to the label: one such session makes the bound overlap-only
    expect(captureToMeta({ now: iso(T0), oldest_open_xact_at: null, invisible_sessions: 1 }).late_commit_bound).toBe("overlap-only");
  });
  it("still counts a visible client backend with no state", () => {
    expect(capture([[8, "client backend", null, null]])).toBe(1);
  });
  // PostgreSQL's documented pg_stat_activity.state values, plus NULL and an
  // unknown future value. Only a state whose xact_start is trustworthy may
  // count as observed (review r5 #1).
  it.each([
    ["active", "active", iso(T0), "observed"],
    ["idle", "idle", null, "observed"],
    ["idle in transaction", "idle in transaction", iso(T0), "observed"],
    ["idle in transaction (aborted)", "idle in transaction (aborted)", iso(T0), "observed"],
    ["fastpath function call", "fastpath function call", iso(T0), "observed"],
    ["disabled (track_activities=off clears xact_start)", "disabled", null, "overlap-only"],
    ["NULL (role cannot inspect)", null, null, "overlap-only"],
    ["an unrecognised future state", "some future state", null, "overlap-only"],
    ["active but no xact_start (inconsistent row)", "active", null, "overlap-only"],
    ["idle in transaction but no xact_start", "idle in transaction", null, "overlap-only"],
  ])("client backend in state %s -> %s", (_label, state, xact, bound) => {
    const n = capture([[9, "client backend", state, xact]]);
    expect(captureToMeta({ now: iso(T0), oldest_open_xact_at: null, invisible_sessions: n }).late_commit_bound).toBe(bound);
  });
  it.each([[undefined], [null], ["x"], [Number.NaN], [-1]])("captureToMeta never says observed for invisible_sessions=%s", (v) => {
    expect(captureToMeta({ now: iso(T0), oldest_open_xact_at: null, invisible_sessions: v }).late_commit_bound).toBe("overlap-only");
  });
  it("does not count visible sessions, background workers, or the observer itself", () => {
    expect(
      capture([
        [1, "client backend", "idle", null],
        [2, "client backend", "active", iso(T0)],
        [3, "autovacuum worker", null, null],
        [4, "checkpointer", null, null],
        [OBSERVER, null, null, null],
        [OBSERVER, "client backend", null, null],
      ]),
    ).toBe(0);
  });
});

describe.skipIf(!sqlite)("backup inventory classification (review r3 #2, #3)", () => {
  const tableDb = (names: string[]) => {
    const db = new DatabaseSync(":memory:");
    for (const n of names) db.exec(`CREATE TABLE "${n}" (id INTEGER PRIMARY KEY)`);
    return db;
  };

  it("dataTables excludes SQLite internals by literal prefix, not by LIKE wildcard", () => {
    const db = tableDb(["sqliteX", "normal"]);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)"); // creates sqlite_sequence
    db.prepare("INSERT INTO t DEFAULT VALUES").run();
    expect(dataTables(db)).toEqual(["normal", "sqliteX", "t"]);
    db.close();
  });

  it("completeInventory refuses a table nobody proved absent, instead of recording it as absent", () => {
    const db = tableDb(["daily_bars", "gone"]);
    db.exec("INSERT INTO daily_bars VALUES (1)");
    const entries = [{ table: "daily_bars", mode: "full" as const, rows: 1 }];
    expect(() => completeInventory(db, entries, new Set(), new Set())).toThrow(/gone.*not proven absent|not proven absent.*gone/);
    const done = completeInventory(db, entries, new Set(), new Set(["gone"]));
    expect(done.find((e) => e.table === "gone")).toMatchObject({ mode: "absent", rows: 0 });
    const filtered = completeInventory(db, entries, new Set(["gone"]), new Set());
    expect(filtered.find((e) => e.table === "gone")).toMatchObject({ mode: "excluded" });
    db.close();
  });

  const lookup = (present: string[]) => async (t: string) => present.includes(t);
  it("a table hidden from information_schema discovery but still in pg_class fails closed", async () => {
    await expect(
      provenAbsentTables({ mirrorTables: ["daily_bars", "news_articles"], sourceTables: ["news_articles"], excluded: new Set(), baseCaptured: new Set(), existsInSource: lookup(["daily_bars"]) }),
    ).rejects.toThrow(/daily_bars.*pg_class/);
  });
  it("a table the base captured that vanishes from discovery fails closed even if pg_class shows nothing", async () => {
    await expect(
      provenAbsentTables({ mirrorTables: ["daily_bars"], sourceTables: [], excluded: new Set(), baseCaptured: new Set(["daily_bars"]), existsInSource: lookup([]) }),
    ).rejects.toThrow(/daily_bars.*previous backup/);
  });
  it("returns only tables with independent evidence, and skips excluded and discovered ones", async () => {
    const out = await provenAbsentTables({
      mirrorTables: ["a", "b", "c", "d"],
      sourceTables: ["a"],
      excluded: new Set(["b"]),
      baseCaptured: new Set(["a"]),
      existsInSource: lookup([]),
    });
    expect([...out].sort()).toEqual(["c", "d"]);
  });

  it("planIncremental reports the tables the base actually captured", () => {
    const base = {
      meta: { captured_at: iso(T0), schema_sha256: "s", oldest_open_xact_at: "" },
      manifest: { a: { mode: "full" }, b: { mode: "delta" }, c: { mode: "absent" } },
    };
    expect([...(planIncremental(base as never, "s") as unknown as { capturedTables: Set<string> }).capturedTables].sort()).toEqual(["a", "b"]);
  });

  it("restore refuses a link that turns a previously captured table into 'absent' (would restore zero rows)", async () => {
    const { validateChain } = await import("../scripts/backup-restore.mjs");
    const meta = (kind: string, at: string, base?: string) => ({ kind, captured_at: at, base_captured_at: base, schema_sha256: "s", shape_sha256: "h" });
    const mk = (path: string, m: ReturnType<typeof meta>, mode: string) => ({ path, meta: m, manifest: { daily_bars: { mode } } });
    const base = mk("b0", meta("full", "t0"), "full");
    expect(() => validateChain([base, mk("b1", meta("incremental", "t1", "t0"), "delta")])).not.toThrow();
    expect(() => validateChain([base, mk("b1", meta("incremental", "t1", "t0"), "absent")])).toThrow(/daily_bars.*absent/);
  });

  it("restore refuses absent -> delta -> absent: a table first captured after the full link (review r4 #1)", async () => {
    const { validateChain } = await import("../scripts/backup-restore.mjs");
    const meta = (kind: string, at: string, base?: string) => ({ kind, captured_at: at, base_captured_at: base, schema_sha256: "s", shape_sha256: "h" });
    const mk = (path: string, m: ReturnType<typeof meta>, mode: string) => ({ path, meta: m, manifest: { daily_bars: { mode } } });
    const full = mk("b0", meta("full", "t0"), "absent");
    const delta = mk("b1", meta("incremental", "t1", "t0"), "delta");
    expect(() => validateChain([full, delta])).not.toThrow();
    expect(() => validateChain([full, delta, mk("b2", meta("incremental", "t2", "t1"), "absent")])).toThrow(/b2.*daily_bars.*absent/);
    // a table that stays absent throughout is still fine
    expect(() => validateChain([full, mk("b1", meta("incremental", "t1", "t0"), "absent")])).not.toThrow();
  });
});

describe.skipIf(!sqlite)("backup-to-sqlite CLI with a permission-hidden table (review r4 #2)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "bk-cli-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /**
   * Run the real CLI against a stub `@neondatabase/serverless` that answers
   * discovery from `visible`, answers the pg_class catalog lookup true for
   * `hidden`, and serves every table as empty.
   */
  function runCli(cliArgs: string[], visible: string[], hidden: string[]) {
    mkdirSync(join(dir, "lib", "db"), { recursive: true });
    cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "lib", "db", "schema.sqlite.sql"), SCHEMA_SQL);
    const pkg = join(dir, "node_modules", "@neondatabase", "serverless");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@neondatabase/serverless", type: "module", main: "index.mjs" }));
    writeFileSync(
      join(pkg, "index.mjs"),
      `import { DatabaseSync } from "node:sqlite";
       import { readFileSync } from "node:fs";
       const mirror = new DatabaseSync(":memory:");
       mirror.exec(readFileSync("lib/db/schema.sqlite.sql", "utf8"));
       const cfg = JSON.parse(process.env.STUB_CFG);
       function answer(text, params) {
         if (/information_schema\.tables/.test(text)) return cfg.visible.map((table_name) => ({ table_name }));
         if (/information_schema\.columns/.test(text)) {
           return mirror.prepare('PRAGMA table_info("' + params[0] + '")').all()
             .map((c) => ({ column_name: c.name, data_type: "text", udt_name: "text" }));
         }
         if (/pg_class/.test(text)) return cfg.hidden.includes(params[0]) ? [{ "?column?": 1 }] : [];
         if (/pg_stat_activity/.test(text)) return [{ now: new Date().toISOString(), oldest_open_xact_at: null, invisible_sessions: 0 }];
         return [];
       }
       export function neon() {
         const sql = async (strings, ...values) => answer(strings.reduce((a, s, i) => a + s + (i < values.length ? "$" + (i + 1) : ""), ""), values);
         sql.query = async (text, params) => answer(text, params ?? []);
         return sql;
       }`,
    );
    const out = join(dir, "out.sqlite");
    const res = spawnSync(process.execPath, [join(dir, "scripts", "backup-to-sqlite.mjs"), `--out=${out}`, ...cliArgs], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", DATABASE_URL: "postgresql://example.invalid/db", STUB_CFG: JSON.stringify({ visible, hidden }) },
    });
    return { res, out };
  }

  const modeOf = (out: string, table: string) => {
    const db = new DatabaseSync(out, { readOnly: true });
    try {
      return (db.prepare("SELECT mode FROM _backup_manifest WHERE table_name = ?").get(table) as { mode: string } | undefined)?.mode;
    } finally {
      db.close();
    }
  };

  it.each([
    ["--tables=news_articles"],
    ["--exclude=daily_bars"],
  ])("%s exports and records the hidden daily_bars as excluded", (flag) => {
    const { res, out } = runCli([flag], ["news_articles"], ["daily_bars"]);
    expect(res.stderr).not.toMatch(/pg_class|hidden from information_schema/);
    expect(res.status).toBe(0);
    expect(modeOf(out, "daily_bars")).toBe("excluded");
    expect(modeOf(out, "news_articles")).toBe("full");
  });

  it("still fails when a REQUESTED table exists but is hidden from discovery", () => {
    const { res, out } = runCli(["--tables=news_articles,daily_bars"], ["news_articles"], ["daily_bars"]);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/"daily_bars" exists in pg_class but is hidden/);
    expect(existsSync(out)).toBe(false);
  });
});
