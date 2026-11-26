import { describe, expect, it, vi } from "vitest";
import { Client } from "langsmith";
import { readFile } from "node:fs/promises";

it("actual pinned SDK evaluates the verified Example array with all transport intercepted", async () => {
  vi.stubEnv("LANGSMITH_API_KEY", "synthetic-offline-key");
  vi.stubEnv("LANGSMITH_API_URL", "http://127.0.0.1:1");
  const { createClient, runExperiment } = await import("../scripts/council-langsmith-eval.mjs");
  const fixture = JSON.parse(await readFile(new URL("../fixtures/langsmith/council-fallback-contract-v1.json", import.meta.url), "utf8"));
  const dataset = { id: "00000000-0000-4000-8000-000000000001", name: fixture.datasetName, metadata: { synthetic_fixture: true, fixture_version: 1 } };
  const client = createClient();
  const network = vi.fn(() => { throw new Error("Network forbidden"); }); vi.stubGlobal("fetch", network);
  const prepared: Record<string, any>[] = []; const feedback: any[] = [];
  vi.spyOn(client, "listDatasets").mockImplementation(async function* () { yield dataset as never; });
  vi.spyOn(client, "listExamples").mockImplementation(async function* () {
    for (const [i, e] of fixture.examples.entries()) yield { id: `00000000-0000-4000-8000-00000000000${i + 2}`, dataset_id: dataset.id, created_at: "2026-11-16T00:00:00Z", modified_at: "2026-11-16T00:00:00Z",
      inputs: e.inputs, outputs: e.outputs, metadata: { fixture_key: e.fixtureKey, synthetic_fixture: true } } as never;
  });
  vi.spyOn(client, "createProject").mockResolvedValue({ id: "00000000-0000-4000-8000-000000000007", name: "synthetic-experiment", reference_dataset_id: dataset.id } as never);
  vi.spyOn(client, "getDatasetUrl").mockResolvedValue("http://127.0.0.1:1/synthetic");
  vi.spyOn(client, "updateProject").mockResolvedValue({} as never);
  vi.spyOn(client, "logEvaluationFeedback").mockImplementation(async (args: any) => { feedback.push(args.evaluatorResponse); return []; });
  vi.spyOn(client, "createRun").mockImplementation(async (run: any) => { prepared.push(await (client as any).prepareRunCreateOrUpdateInputs(run)); });
  vi.spyOn(client, "updateRun").mockImplementation(async (_id, run: any) => { prepared.push(await (client as any).prepareRunCreateOrUpdateInputs(run)); });
  vi.spyOn(client, "awaitPendingTraceBatches").mockResolvedValue(undefined);
  try {
    await runExperiment(client);
    expect(feedback).toHaveLength(4);
    expect(feedback.every(r => r.results?.[0]?.score === true || r.score === true)).toBe(true);
    expect(client.listExamples).toHaveBeenCalledTimes(1);
    expect(prepared.length).toBeGreaterThan(0);
    expect(network).not.toHaveBeenCalled();
    expect(await (client as any).processError("SYNTHETIC_PRIVATE_ERROR")).toBe("[redacted]");
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
