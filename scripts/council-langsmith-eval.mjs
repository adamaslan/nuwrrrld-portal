import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/langsmith/council-fallback-contract-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
const args = new Set(process.argv.slice(2));

export function evaluateAttempts(attempts) {
  const safeAttempts = Array.isArray(attempts) ? attempts : [];
  const emptyCompletionCount = safeAttempts.filter(
    (attempt) => attempt?.http_status >= 200 && attempt?.http_status < 300 &&
      (attempt?.has_content === false || attempt?.content_length === 0),
  ).length;
  const hasUsableAnswer = safeAttempts.some(
    (attempt) => attempt?.http_status >= 200 && attempt?.http_status < 300 &&
      attempt?.has_content === true && Number.isFinite(attempt?.content_length) && attempt.content_length > 0,
  );
  return {
    has_usable_answer: hasUsableAnswer,
    empty_completion_count: emptyCompletionCount,
    attempt_count: safeAttempts.length,
  };
}

function matchesReference(actual, expected) {
  return actual.has_usable_answer === expected.has_usable_answer &&
    actual.empty_completion_count === expected.empty_completion_count &&
    actual.attempt_count === expected.attempt_count;
}

function safeAttempts(attempts) {
  return Array.isArray(attempts)
    ? attempts.map((attempt) => ({
      ...(Number.isInteger(attempt?.http_status) ? { http_status: attempt.http_status } : {}),
      ...(typeof attempt?.finish_reason === "string" ? { finish_reason: attempt.finish_reason.slice(0, 32) } : {}),
      ...(Number.isFinite(attempt?.reasoning_tokens) ? { reasoning_tokens: attempt.reasoning_tokens } : {}),
      ...(Number.isFinite(attempt?.content_length) ? { content_length: attempt.content_length } : {}),
      ...(typeof attempt?.has_content === "boolean" ? { has_content: attempt.has_content } : {}),
    }))
    : [];
}

function safeEvaluationInputs(inputs) {
  return { attempts: safeAttempts((inputs ?? {}).attempts) };
}

function safeEvaluationOutputs(outputs) {
  const values = outputs ?? {};
  return {
    ...(typeof values.has_usable_answer === "boolean"
      ? { has_usable_answer: values.has_usable_answer }
      : {}),
    ...(Number.isInteger(values.empty_completion_count)
      ? { empty_completion_count: values.empty_completion_count }
      : {}),
    ...(Number.isInteger(values.attempt_count) ? { attempt_count: values.attempt_count } : {}),
  };
}

function evaluateLocally() {
  const results = fixture.examples.map((example) => ({
    key: example.fixtureKey,
    passed: matchesReference(evaluateAttempts(example.inputs.attempts), example.outputs),
  }));
  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    console.info(`${result.passed ? "PASS" : "FAIL"} ${result.key}`);
  }
  if (failed.length) process.exitCode = 1;
}

function assertFixtureMatches() {
  for (const example of fixture.examples) {
    if (!matchesReference(evaluateAttempts(example.inputs.attempts), example.outputs)) {
      throw new Error(`Fixture reference does not match deterministic evaluator: ${example.fixtureKey}`);
    }
  }
}

export function createClient() {
  const apiKey = process.env.LANGSMITH_API_KEY?.trim();
  const apiUrl = process.env.LANGSMITH_API_URL?.trim();
  if (!apiKey || !apiUrl) {
    throw new Error("Set LANGSMITH_API_KEY and LANGSMITH_API_URL explicitly for remote operations.");
  }
  return new Client({
    apiKey,
    apiUrl,
    hideInputs: safeEvaluationInputs,
    hideOutputs: safeEvaluationOutputs,
    hideMetadata: (metadata) => ({
      ...((metadata ?? {}).synthetic_fixture === true ? { synthetic_fixture: true } : {}),
      ...((metadata ?? {}).fixture_version === 1 ? { fixture_version: 1 } : {}),
    }),
    anonymizer: () => ({ error: "[redacted]" }),
    omitTracedRuntimeInfo: true,
    blockOnRootRunFinalization: false,
  });
}

export async function findDataset(client) {
  let found = null;
  for await (const dataset of client.listDatasets({ datasetName: fixture.datasetName, limit: 10 })) {
    if (dataset.name !== fixture.datasetName) continue;
    if (found || !uuid.test(dataset.id) || dataset.metadata?.synthetic_fixture !== true || dataset.metadata?.fixture_version !== 1) {
      throw new Error("Dataset identity/provenance mismatch; refusing remote operation.");
    }
    found = dataset;
  }
  return found;
}

// Validate every remote example before any experiment. The evaluator receives a
// fresh allowlisted local snapshot, never a dataset-name lookup or remote prose.
export async function verifiedExamples(client, dataset, allowMissing = false) {
  const expected = new Map(fixture.examples.map(example => [example.fixtureKey, example]));
  const seen = new Set();
  const snapshot = [];
  for await (const example of client.listExamples({ datasetId: dataset.id })) {
    const key = example.metadata?.fixture_key;
    const reference = expected.get(key);
    if (!reference || seen.has(key) || example.dataset_id !== dataset.id ||
        typeof example.id !== "string" || !uuid.test(example.id) ||
        typeof example.created_at !== "string" || !isoDate.test(example.created_at) ||
        typeof example.modified_at !== "string" || !isoDate.test(example.modified_at) ||
        !Number.isFinite(Date.parse(example.created_at)) || !Number.isFinite(Date.parse(example.modified_at)) ||
        example.metadata?.synthetic_fixture !== true ||
        !isDeepStrictEqual(example.inputs, reference.inputs) ||
        !isDeepStrictEqual(example.outputs, reference.outputs) ||
        (example.attachments && Object.keys(example.attachments).length)) {
      throw new Error("Dataset example mismatch; refusing remote operation.");
    }
    seen.add(key);
    snapshot.push({
      id: example.id, dataset_id: dataset.id,
      inputs: structuredClone(reference.inputs), outputs: structuredClone(reference.outputs),
      metadata: { fixture_key: key, synthetic_fixture: true },
      created_at: example.created_at, modified_at: example.modified_at,
    });
  }
  if (!allowMissing && seen.size !== expected.size) {
    throw new Error("Dataset example set incomplete; refusing experiment.");
  }
  return { snapshot, missing: fixture.examples.filter(example => !seen.has(example.fixtureKey)) };
}

export async function uploadFixture(client = createClient()) {
  let dataset = await findDataset(client);
  if (!dataset) {
    dataset = await client.createDataset(fixture.datasetName, {
      description: fixture.description, dataType: "kv",
      metadata: { synthetic_fixture: true, fixture_version: 1 },
    });
  }
  const { missing } = await verifiedExamples(client, dataset, true);
  if (missing.length) {
    await client.createExamples(missing.map(example => ({
      dataset_id: dataset.id, inputs: example.inputs, outputs: example.outputs,
      metadata: { fixture_key: example.fixtureKey, synthetic_fixture: true },
    })));
  }
  await verifiedExamples(client, dataset);
  console.info(`Verified ${fixture.examples.length} synthetic examples; uploaded ${missing.length}.`);
}

export async function runExperiment(client = createClient(), evaluator = evaluate) {
  const dataset = await findDataset(client);
  if (!dataset) throw new Error("Verified synthetic dataset missing; run explicit upload separately.");
  const { snapshot } = await verifiedExamples(client, dataset);
  await evaluator(
    input => evaluateAttempts(input.attempts),
    {
      data: snapshot, client,
      experimentPrefix: "council-fallback-contract",
      metadata: { synthetic_fixture: true, fixture_version: 1 },
      evaluators: [({ outputs, referenceOutputs }) => {
        const passed = matchesReference(outputs, referenceOutputs ?? {});
        return { key: "fallback_contract", score: passed, value: passed ? "pass" : "fail",
          comment: "Deterministic status/content-count comparison; no model judge." };
      }],
    },
  );
  console.info(`Completed verified synthetic experiment for ${fixture.datasetName}.`);
}

assertFixtureMatches();

if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : "")) {
if (args.has("--upload") && args.has("--experiment")) {
  throw new Error("Run --upload and --experiment as separate explicit commands.");
} else if (args.has("--upload")) {
  await uploadFixture();
} else if (args.has("--experiment")) {
  await runExperiment();
} else if (args.size === 0 || args.has("--local")) {
  evaluateLocally();
} else {
  throw new Error("Usage: node scripts/council-langsmith-eval.mjs [--local|--upload|--experiment]");
}

}
