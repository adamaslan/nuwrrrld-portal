/**
 * pipeline-run-log list — regression tests for the runs-list read.
 *
 * The runs list only needs per-outcome counts for each run. It used to select
 * every run's full `items` JSON array (up to 200 runs, on every dynamic page
 * load). These tests pin three things:
 *   1. the list query no longer projects `items`;
 *   2. outcome counts come from SQL and map onto the same four outcomes that
 *      `summarizeOutcomes` produces from the full array;
 *   3. a database error still propagates instead of becoming an empty list.
 *
 * `@/lib/db` is mocked; the query text and the returned rows are what we check.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const query = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/lib/db", () => ({
  default: (strings: TemplateStringsArray, ...values: unknown[]) =>
    query.run(strings.join("?"), values),
}));

const { listPipelineRuns, outcomesFromCounts, summarizeOutcomes } = await import(
  "@/lib/pipeline-run-log-db"
);

const ITEMS = [
  { subject: "AAPL", model: "m1", outcome: "ok" },
  { subject: "MSFT", model: "m1", outcome: "ok" },
  { subject: "NVDA", model: null, outcome: "skip" },
  { subject: "TSLA", model: "m2", outcome: "fail" },
] as const;

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    pipeline: "followed-tickers",
    run_at: "2026-11-27T12:00:00Z",
    dry_run: false,
    session: null,
    items_total: 4,
    items_ai: 3,
    models: {},
    summary: {},
    outcome_counts: { ok: 2, skip: 1, fail: 1 },
    ...overrides,
  };
}

beforeEach(() => {
  query.run.mockReset();
});

describe("listPipelineRuns query", () => {
  it("does not project the items column", async () => {
    query.run.mockResolvedValueOnce([baseRow()]);
    await listPipelineRuns(50);

    const [sqlText] = query.run.mock.calls[0];
    // The projected column list ends with `items, summary` in the old query.
    expect(sqlText).not.toMatch(/\bitems,/);
  });

  it("returns outcome counts from SQL and an empty items array", async () => {
    query.run.mockResolvedValueOnce([baseRow()]);
    const [run] = await listPipelineRuns(50);

    expect(run.items).toEqual([]);
    expect(run.outcomes).toEqual({ ok: 2, empty: 0, fail: 1, skip: 1 });
  });

  it("propagates a database error instead of returning an empty list", async () => {
    query.run.mockRejectedValueOnce(new Error("connection refused"));
    await expect(listPipelineRuns(50)).rejects.toThrow("connection refused");
  });
});

describe("outcomesFromCounts", () => {
  it("folds unknown keys out and defaults missing outcomes to zero", () => {
    expect(outcomesFromCounts({ ok: 3, skip: 1, bogus: 9 })).toEqual({
      ok: 3,
      empty: 0,
      fail: 0,
      skip: 1,
    });
  });

  it("treats a non-object payload as all zeros", () => {
    expect(outcomesFromCounts(null)).toEqual({ ok: 0, empty: 0, fail: 0, skip: 0 });
    expect(outcomesFromCounts("[]")).toEqual({ ok: 0, empty: 0, fail: 0, skip: 0 });
  });

  it("matches summarizeOutcomes on the same items", () => {
    const counts: Record<string, number> = {};
    for (const it of ITEMS) counts[it.outcome] = (counts[it.outcome] ?? 0) + 1;

    expect(outcomesFromCounts(counts)).toEqual(summarizeOutcomes([...ITEMS]));
  });
});
