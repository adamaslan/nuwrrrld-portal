import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const script = "../scripts/council-langsmith-eval.mjs";
const fixture = JSON.parse(await readFile(new URL("../fixtures/langsmith/council-fallback-contract-v1.json", import.meta.url), "utf8"));
const dataset = { id: "00000000-0000-4000-8000-000000000001", name: fixture.datasetName, metadata: { synthetic_fixture: true, fixture_version: 1 } };
function records() { return fixture.examples.map((e: any, i: number) => ({ id: `00000000-0000-4000-8000-00000000000${i + 2}`, dataset_id: dataset.id, created_at: "2026-11-16T00:00:00Z", modified_at: "2026-11-16T00:00:00Z", inputs: structuredClone(e.inputs), outputs: structuredClone(e.outputs), metadata: { fixture_key: e.fixtureKey, synthetic_fixture: true } })); }
function client(examples = records(), datasets = [dataset]) {
  return { listDatasets: async function* () { yield* datasets; }, listExamples: async function* () { yield* examples; }, createExamples: vi.fn(), createDataset: vi.fn() };
}
describe("Council evaluation remote fixture boundary, offline mocked SDK", () => {
  it("passes only a verified local snapshot, not a mutable remote dataset name", async () => {
    const { runExperiment } = await import(script); const rows = records(); const evaluate = vi.fn(async (_target, options) => {
      expect(Array.isArray(options.data)).toBe(true); expect(options.data).toHaveLength(4);
      rows[0].inputs.attempts[0].http_status = 999;
      expect(options.data[0].inputs).toEqual(fixture.examples[0].inputs);
      expect(options.data[0].metadata).toEqual({ fixture_key: fixture.examples[0].fixtureKey, synthetic_fixture: true });
    });
    await runExperiment(client(rows), evaluate); expect(evaluate).toHaveBeenCalledTimes(1);
  });
  for (const kind of ["extra", "mutated", "missing", "duplicate", "wrong-dataset", "attachments", "not-synthetic"]) {
    it(`rejects ${kind} remote examples before evaluation or upload`, async () => {
      const { runExperiment, uploadFixture } = await import(script); const rows = records();
      if (kind === "extra") rows.push({ ...rows[0], id: "foreign", metadata: { fixture_key: "foreign", synthetic_fixture: true } });
      if (kind === "mutated") rows[0].inputs.attempts[0].content_length = 999;
      if (kind === "missing") rows.pop();
      if (kind === "duplicate") rows.push(rows[0]);
      if (kind === "wrong-dataset") rows[0].dataset_id = "foreign";
      if (kind === "attachments") (rows[0] as any).attachments = { private: {} };
      if (kind === "not-synthetic") rows[0].metadata.synthetic_fixture = false;
      const c = client(rows); const evaluate = vi.fn(); await expect(runExperiment(c, evaluate)).rejects.toThrow(); expect(evaluate).not.toHaveBeenCalled();
      if (kind !== "missing") { await expect(uploadFixture(c)).rejects.toThrow(); expect(c.createExamples).not.toHaveBeenCalled(); }
    });
  }
  it("refuses an existing dataset without matching provenance", async () => {
    const { runExperiment } = await import(script); const evaluate = vi.fn();
    await expect(runExperiment(client(records(), [{ ...dataset, metadata: { synthetic_fixture: false, fixture_version: 1 } }]), evaluate)).rejects.toThrow(); expect(evaluate).not.toHaveBeenCalled();
  });
});
