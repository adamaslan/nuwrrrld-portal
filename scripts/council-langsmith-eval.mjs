import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "langsmith";
import { evaluate } from "langsmith/evaluation";

const FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/langsmith/council-fallback-contract-v1.json", import.meta.url),
);
const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
const args = new Set(process.argv.slice(2));

function evaluateAttempts(attempts) {
  const safeAttempts = Array.isArray(attempts) ? attempts : [];
  const emptyCompletionCount = safeAttempts.filter(
    (attempt) => attempt?.http_status >= 200 && attempt?.http_status < 300 && attempt?.has_content === false,
  ).length;
  const hasUsableAnswer = safeAttempts.some(
    (attempt) => attempt?.http_status >= 200 && attempt?.http_status < 300 && attempt?.has_content === true,
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
  return { attempts: safeAttempts(inputs.attempts) };
}

function safeEvaluationOutputs(outputs) {
  return {
    ...(typeof outputs.has_usable_answer === "boolean"
      ? { has_usable_answer: outputs.has_usable_answer }
      : {}),
    ...(Number.isInteger(outputs.empty_completion_count)
      ? { empty_completion_count: outputs.empty_completion_count }
      : {}),
    ...(Number.isInteger(outputs.attempt_count) ? { attempt_count: outputs.attempt_count } : {}),
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

function createClient() {
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
    anonymizer: () => ({}),
    omitTracedRuntimeInfo: true,
    blockOnRootRunFinalization: false,
  });
}

async function findDataset(client) {
  for await (const dataset of client.listDatasets({ datasetName: fixture.datasetName, limit: 10 })) {
    if (dataset.name === fixture.datasetName) return dataset;
  }
  return null;
}

async function uploadFixture() {
  const client = createClient();
  let dataset = await findDataset(client);
  if (!dataset) {
    dataset = await client.createDataset(fixture.datasetName, {
      description: fixture.description,
      dataType: "kv",
      metadata: { synthetic_fixture: true, fixture_version: 1 },
    });
  }

  const existingKeys = new Set();
  for await (const example of client.listExamples({ datasetId: dataset.id, limit: 100 })) {
    if (typeof example.metadata?.fixture_key === "string") {
      existingKeys.add(example.metadata.fixture_key);
    }
  }
  const missing = fixture.examples.filter((example) => !existingKeys.has(example.fixtureKey));
  if (missing.length) {
    await client.createExamples(missing.map((example) => ({
      dataset_id: dataset.id,
      inputs: example.inputs,
      outputs: example.outputs,
      metadata: { fixture_key: example.fixtureKey, synthetic_fixture: true },
    })));
  }
  console.info(`Uploaded ${missing.length} synthetic examples to ${fixture.datasetName}.`);
}

async function runExperiment() {
  const client = createClient();
  await evaluate(
    (input) => evaluateAttempts(input.attempts),
    {
      data: fixture.datasetName,
      client,
      experimentPrefix: "council-fallback-contract",
      metadata: { synthetic_fixture: true, fixture_version: 1 },
      evaluators: [({ outputs, referenceOutputs }) => {
        const passed = matchesReference(outputs, referenceOutputs ?? {});
        return {
          key: "fallback_contract",
          score: passed,
          value: passed ? "pass" : "fail",
          comment: "Deterministic status/content-count comparison; no model judge.",
        };
      }],
    },
  );
  console.info(`Completed synthetic LangSmith experiment for ${fixture.datasetName}.`);
}

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
