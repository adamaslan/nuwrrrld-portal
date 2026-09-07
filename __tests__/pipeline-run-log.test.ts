/**
 * pipeline-run-log — unit tests for the per-model rollup.
 *
 * `@/lib/db` is mocked so importing the module needs no DATABASE_URL. Only
 * `rollupModels` has real logic worth pinning; `logPipelineRun` is a single
 * INSERT wrapped in a swallow-all catch and is exercised end-to-end by the
 * pipeline route tests / a Neon branch, not here.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  default: () => Promise.reject(new Error("DB query attempted in a rollup unit test")),
}));

const { rollupModels } = await import("@/lib/pipeline-run-log-db");

describe("rollupModels", () => {
  it("counts calls, empties and fallbacks per model", () => {
    const out = rollupModels([
      { subject: "AAPL", seat: "T1", model: "a:free", outcome: "ok", latencyMs: 1000 },
      { subject: "MSFT", seat: "T1", model: "a:free", outcome: "empty", latencyMs: 2000 },
      { subject: "NVDA", seat: "T1", model: "b:free", outcome: "ok", fallback: true, latencyMs: 500 },
    ]);
    expect(out["a:free"]).toEqual({ calls: 2, empty: 1, fallbacks: 0, avgLatencyMs: 1500 });
    expect(out["b:free"]).toEqual({ calls: 1, empty: 0, fallbacks: 1, avgLatencyMs: 500 });
  });

  it("skips items with no served model", () => {
    const out = rollupModels([
      { subject: "AAPL", seat: "T1", model: null, outcome: "fail" },
      { subject: "MSFT", seat: "T1", model: null, outcome: "skip" },
    ]);
    expect(out).toEqual({});
  });

  it("reports null average latency when no item carried a latency", () => {
    const out = rollupModels([
      { subject: "x", model: "m:free", outcome: "ok" },
      { subject: "y", model: "m:free", outcome: "ok" },
    ]);
    expect(out["m:free"]).toEqual({ calls: 2, empty: 0, fallbacks: 0, avgLatencyMs: null });
  });

  it("returns an empty object for no items", () => {
    expect(rollupModels([])).toEqual({});
  });
});
