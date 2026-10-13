import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ sql: vi.fn(), transaction: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: Object.assign(db.sql, { transaction: db.transaction }) }));
const { logPipelineRun } = await import("@/lib/pipeline-run-log-db");

const run = {
  pipeline: "hydrate-universe" as const,
  dryRun: false,
  itemsTotal: 1,
  items: [{ subject: "AAPL", model: null, outcome: "fail" as const }],
  summary: { failed: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  db.sql.mockResolvedValue([]);
  db.query.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => ({
    text: strings.join("?"), values,
  }));
  db.transaction.mockImplementation(async (callback) => callback(db.query));
});

describe("pipeline run persistence", () => {
  it.each([undefined, null])("derives omitted/null status (%s)", async (status) => {
    expect(await logPipelineRun({ ...run, status })).toBe(true);
    const values = db.sql.mock.calls[0].slice(1);
    expect(values[10]).toBe("fail");
    expect(values[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves an explicitly computed status", async () => {
    await logPipelineRun({ ...run, status: "partial" });
    expect(db.sql.mock.calls[0][11]).toBe("partial");
  });

  it("locks pipeline/session before replacing or inserting a final aggregate", async () => {
    const aggregate = { ...run, session: "nightly-2026-10-13", upsertSession: true };
    expect(await logPipelineRun(aggregate)).toBe(true);
    expect(await logPipelineRun(aggregate)).toBe(true);
    expect(db.sql).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.transaction.mock.calls[0][1]).toEqual({ isolationLevel: "ReadCommitted" });
    const [lock, write] = db.query.mock.results.map((result) => result.value);
    expect(lock.text).toContain("pg_advisory_xact_lock");
    expect(lock.values).toEqual([JSON.stringify([aggregate.pipeline, aggregate.session])]);
    expect(write.text).toContain("UPDATE pipeline_run_log");
    expect(write.text).toContain("WHERE pipeline = ? AND session = ?");
    expect(write.text).toContain("WHERE NOT EXISTS (SELECT 1 FROM updated)");
    expect(write.values).toContain("fail");
    expect(write.values).toContain(JSON.stringify(run.items));
  });

  it.each([undefined, null, "", "  "])("rejects session upsert without a session (%s)", async (session) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await logPipelineRun({ ...run, upsertSession: true, session })).toBe(false);
    expect(db.sql).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it("returns false when persistence fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.transaction.mockRejectedValueOnce(new Error("offline"));
    expect(await logPipelineRun({ ...run, session: "nightly", upsertSession: true })).toBe(false);
    warning.mockRestore();
  });
});
