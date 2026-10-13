import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sql } = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: sql }));
import { enqueueUncachedActiveSignals, fetchTickerEntry } from "@/lib/shared/signal-lookup";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE ticker_universe (ticker TEXT PRIMARY KEY, active BOOLEAN);
    CREATE TABLE signal_cache (ticker TEXT PRIMARY KEY, payload TEXT, generated_at TEXT);
    CREATE TABLE pending_signals (
      ticker TEXT, requested_by TEXT, status TEXT DEFAULT 'pending'
    );
    CREATE UNIQUE INDEX one_pending ON pending_signals(ticker) WHERE status = 'pending';
  `);
  sql.mockImplementation(async (parts: TemplateStringsArray, ...values: (string | number)[]) =>
    db.prepare(parts.join("?").replaceAll("now()", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"))
      .all(...values).map((value) => {
        const row = value as Record<string, unknown>;
        return { ...row, ...(typeof row.payload === "string" ? { payload: JSON.parse(row.payload) } : {}) };
      }));
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("active universe cold-cache queue seeding", () => {
  it("covers more than one batch without cache hits or inactive tickers", async () => {
    const insert = db.prepare("INSERT INTO ticker_universe VALUES (?, ?)");
    for (let i = 0; i < 19; i++) insert.run(`T${String.fromCharCode(65 + i)}`, 1);
    insert.run("OFF", 0);
    db.prepare("INSERT INTO signal_cache VALUES ('TA', ?, ?)").run('{"ai_action":"HOLD"}', new Date().toISOString());

    expect(await enqueueUncachedActiveSignals()).toBe(8);
    expect(await enqueueUncachedActiveSignals()).toBe(8);
    expect(await enqueueUncachedActiveSignals()).toBe(2);
    expect(await enqueueUncachedActiveSignals()).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM pending_signals").all()).toEqual([{ n: 18 }]);
    expect(db.prepare("SELECT * FROM pending_signals WHERE ticker IN ('OFF', 'TA')").all()).toEqual([]);
  });

  it("respects pending backoff, processing leases and terminal retry history", async () => {
    for (const status of ["pending", "processing", "done", "error"]) {
      db.prepare("INSERT INTO ticker_universe VALUES (?, 1)").run(status);
      db.prepare("INSERT INTO pending_signals VALUES (?, 'user', ?)").run(status, status);
    }
    expect(await enqueueUncachedActiveSignals()).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM pending_signals").all()).toEqual([{ n: 4 }]);
  });

  it("degrades without blocking the drain if optional seeding fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sql.mockRejectedValueOnce(new Error("universe unavailable"));
    expect(await enqueueUncachedActiveSignals()).toBe(0);
  });

  it("hydrates every active cold ticker across bounded batches using read-through writes", async () => {
    for (let i = 0; i < 19; i++) {
      db.prepare("INSERT INTO ticker_universe VALUES (?, 1)").run(`T${String.fromCharCode(65 + i)}`);
    }
    const fetch = vi.fn(async (url: string) => {
      const ticker = new URL(url).searchParams.get("symbol")!;
      return new Response(JSON.stringify({ symbols: { [ticker]: { ai_action: "HOLD" } } }));
    });
    vi.stubGlobal("fetch", fetch);
    for (const expected of [8, 8, 3]) {
      expect(await enqueueUncachedActiveSignals()).toBe(expected);
      const before = fetch.mock.calls.length;
      for (const row of db.prepare("SELECT ticker FROM pending_signals WHERE status = 'pending'").all() as { ticker: string }[]) {
        await fetchTickerEntry(row.ticker as string);
        db.prepare("UPDATE pending_signals SET status = 'done' WHERE ticker = ?").run(row.ticker as string);
      }
      expect(fetch.mock.calls.length - before).toBe(expected);
    }
    expect(db.prepare("SELECT count(*) AS n FROM signal_cache").all()).toEqual([{ n: 19 }]);
    expect(await enqueueUncachedActiveSignals()).toBe(0);
    await fetchTickerEntry("TA");
    expect(fetch).toHaveBeenCalledTimes(19); // the now-warm lookup uses L2
  });

  it("keeps stale outage fallback timestamps and volatility-aware expiration", async () => {
    const generatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const insert = db.prepare("INSERT INTO signal_cache VALUES (?, ?, ?)");
    insert.run("HOT", '{"ai_action":"BUY"}', generatedAt);
    insert.run("QUIET", '{"ai_action":"HOLD","confluence_score":50}', generatedAt);
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchTickerEntry("QUIET")).toMatchObject({ ai_action: "HOLD" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await fetchTickerEntry("HOT")).toMatchObject({ ai_action: "BUY" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT generated_at FROM signal_cache WHERE ticker = 'HOT'").all()).toEqual([{ generated_at: generatedAt }]);
  });
});
