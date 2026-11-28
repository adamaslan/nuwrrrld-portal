import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The engine-run skip path: a shadow run whose bars are unchanged since a
 * complete run answers status "unchanged" without reading bars, and every
 * other case still computes. The SQL behind coveringRun is proven against a
 * real Postgres in engine-db.pg.test.ts.
 */
const db = vi.hoisted(() => ({
  coveringRun: vi.fn(),
  listEngineTickers: vi.fn(),
  countEngineTickers: vi.fn(),
  startRun: vi.fn(),
  loadSeries: vi.fn(),
  writeSnapshots: vi.fn(),
  writeHits: vi.fn(),
  mergeCardFibNumerics: vi.fn(),
  bumpRun: vi.fn(),
  markRunComplete: vi.fn(),
}));
vi.mock("@/lib/engine-db", () => db);
const sqlCalls = vi.hoisted(() => ({ transactions: [] as string[][] }));
vi.mock("@/lib/db", () => {
  const tag = (strings: TemplateStringsArray) => ({ text: strings.join("?") });
  tag.transaction = async (queries: Array<{ text: string }>) => {
    sqlCalls.transactions.push(queries.map((q) => q.text));
    return [];
  };
  return { default: tag };
});
vi.mock("@/lib/pipeline-auth", () => ({ requirePushSecret: () => null }));
vi.mock("@/lib/shared/engine-ladder", () => ({ engineLiveEnabled: () => true }));

const { POST } = await import("@/app/api/pipeline/engine-run/route");

const post = async (body: Record<string, unknown>) => {
  const res = await POST(
    new NextRequest("http://localhost/api/pipeline/engine-run", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.coveringRun.mockResolvedValue({ id: "engine-prev", barDate: "2026-11-25" });
  db.listEngineTickers.mockResolvedValue(["AAA", "BBB"]);
  db.countEngineTickers.mockResolvedValue(2);
  db.loadSeries.mockResolvedValue([]);
});

describe("engine-run route skipIfUnchanged", () => {
  it("answers unchanged without reading bars or opening a run when a complete run covers the stored bars", async () => {
    const { status, json } = await post({ runId: "r1", mode: "shadow", feed: "sip", offset: 0, skipIfUnchanged: true });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, status: "unchanged", coveredBy: "engine-prev", barDate: "2026-11-25", nextOffset: null, written: 0 });
    expect(db.coveringRun).toHaveBeenCalledWith("sip", expect.any(String));
    expect(db.loadSeries).not.toHaveBeenCalled();
    expect(db.startRun).not.toHaveBeenCalled();
    expect(db.bumpRun).not.toHaveBeenCalled();
  });

  it("computes and marks the run complete on its last chunk when nothing covers the bars", async () => {
    db.coveringRun.mockResolvedValue(null);
    const { json } = await post({ runId: "r1", mode: "shadow", feed: "sip", offset: 0, skipIfUnchanged: true });
    expect(json).toMatchObject({ status: "computed", nextOffset: null });
    expect(db.loadSeries).toHaveBeenCalledOnce();
    expect(db.bumpRun).toHaveBeenCalledOnce();
    expect(db.markRunComplete).toHaveBeenCalledWith("r1");
  });

  it("does not mark a run complete on a non-final chunk", async () => {
    db.countEngineTickers.mockResolvedValue(5);
    const { json } = await post({ runId: "r1", mode: "shadow", feed: "sip", offset: 0 });
    expect(json.nextOffset).toBe(2);
    expect(db.markRunComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["no opt-in (older callers)", { mode: "shadow", offset: 0 }],
    ["live mode", { mode: "live", offset: 0, skipIfUnchanged: true }],
    ["a later chunk", { mode: "shadow", offset: 400, skipIfUnchanged: true }],
    ["an explicit asOf", { mode: "shadow", offset: 0, asOf: "2026-11-20", skipIfUnchanged: true }],
  ])("always computes for %s", async (_label, body) => {
    const { json } = await post({ runId: "r1", feed: "sip", ...body });
    expect(json.status).toBe("computed");
    expect(db.coveringRun).not.toHaveBeenCalled();
    expect(db.loadSeries).toHaveBeenCalledOnce();
  });

  it("returns 500, not unchanged, when the watermark lookup fails", async () => {
    db.coveringRun.mockRejectedValue(new Error("HTTP 402"));
    const { status } = await post({ runId: "r1", mode: "shadow", feed: "sip", offset: 0, skipIfUnchanged: true });
    expect(status).toBe(500);
  });
});

/** Runs scripts/engine-run.mjs against a stub portal and returns its output and exit code. */
async function runScript(
  handle: (path: string, body: Record<string, unknown>) => Record<string, unknown>,
  args: string[] = [],
) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      calls.push({ path: req.url!, body });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(handle(req.url!, body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const child = spawn(process.execPath, ["scripts/engine-run.mjs", ...args], {
    env: { ...process.env, PORTAL_URL: `http://127.0.0.1:${port}`, PORTAL_PUSH_SECRET: "test-secret" },
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  server.close();
  return { out, code, calls };
}

const label = { written: 0, remaining: 0 };
const computed = { ok: true, status: "computed", processed: 2, written: 2, skipped: 0, failed: 0, degraded: 0, hits: 1, nextOffset: null };

describe("scripts/engine-run.mjs", () => {
  it("reports status=unchanged, still labels, and exits 0 when the route skips", async () => {
    const { out, code, calls } = await runScript((path) =>
      path.endsWith("engine-label") ? label : { ok: true, status: "unchanged", coveredBy: "engine-prev", barDate: "2026-11-25", nextOffset: null },
    );
    expect(code).toBe(0);
    expect(out).toContain("[skip] bars unchanged since finished run engine-prev");
    expect(out).toMatch(/\[done\] runId=\S+ status=unchanged coveredBy=engine-prev/);
    expect(calls.filter((c) => c.path.endsWith("engine-run"))).toHaveLength(1);
    expect(calls[0].body.skipIfUnchanged).toBe(true);
    expect(calls.some((c) => c.path.endsWith("engine-label"))).toBe(true);
  });

  it("--force never asks to skip", async () => {
    const { code, calls } = await runScript((path) => (path.endsWith("engine-label") ? label : computed), ["--force"]);
    expect(code).toBe(0);
    expect(calls[0].body.skipIfUnchanged).toBe(false);
  });

  it("still fails when a computed run wrote nothing (an older route without status behaves the same)", async () => {
    const { code, out } = await runScript((path) =>
      path.endsWith("engine-label") ? label : { ok: true, processed: 2, written: 0, skipped: 2, failed: 0, degraded: 0, hits: 0, nextOffset: null },
    );
    expect(code).toBe(1);
    expect(out).toContain("wrote no structure rows");
  });
});

describe("upsertBars write bound", () => {
  it("sends SET LOCAL statement_timeout and the upsert as one transaction", async () => {
    const { upsertBars } = await vi.importActual<typeof import("@/lib/engine-db")>("@/lib/engine-db");
    const row = { ticker: "AAA", barDate: "2026-11-25", open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 };
    expect(await upsertBars([row], { feed: "sip", adjustment: "split", source: "alpaca" })).toBe(1);
    const [tx] = sqlCalls.transactions;
    expect(tx).toHaveLength(2);
    expect(tx[0]).toBe("SET LOCAL statement_timeout = '5min'");
    expect(tx[1]).toMatch(/INSERT INTO daily_bars[\s\S]*fetched_at = now\(\)[\s\S]*IS DISTINCT FROM/);
  });
});
