#!/usr/bin/env node
/** Copy only named NWF credentials into empty, slot-specific Secret Manager containers. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as nodeUtil from "node:util";

const [envPath, projectId, slot] = process.argv.slice(2);
const slotProjects = new Map([
  ["shadow", "ttb-lang1"],
  ["new", "nwf-new-pipeline-20261015"],
]);
if (!envPath || !projectId || slotProjects.get(slot) !== projectId) {
  console.error("Usage: node infra/sync-shadow-secrets.mjs PATH_TO_NWF_ENV GCP_PROJECT_ID shadow|new");
  console.error("The slot must match its expected project ID.");
  process.exit(2);
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 12)) {
  throw new Error("Node.js 20.12 or newer is required for parseEnv");
}
const { parseEnv } = nodeUtil;

const names = new Map([
  ["ALPACA_API_KEY", `nwf-${slot}-alpaca-api-key`],
  ["ALPACA_API_SECRET", `nwf-${slot}-alpaca-api-secret`],
  ["OPENROUTER_API_KEY", `nwf-${slot}-openrouter-api-key`],
]);

const source = readFileSync(envPath, "utf8");
const parsed = parseEnv(source);

for (const [envName, secretName] of names) {
  const occurrenceCount = source.split("\n").filter(line => new RegExp(`^\\s*(?:export\\s+)?${envName}\\s*=`).test(line)).length;
  if (occurrenceCount !== 1) {
    throw new Error(`${envName}: expected exactly one definition; found ${occurrenceCount}`);
  }

  const value = parsed[envName];
  if (!value || /^(placeholder|changeme|your-key|todo|__unset__)/i.test(value)) {
    throw new Error(`${envName}: missing or placeholder value`);
  }

  const existing = execFileSync("gcloud", [
    "secrets", "versions", "list", secretName,
    `--project=${projectId}`,
    "--filter=state:ENABLED",
    "--format=value(name)",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (existing) {
    console.log(`${secretName}: already has an enabled version; left unchanged`);
    continue;
  }

  try {
    execFileSync("gcloud", [
      "secrets", "versions", "add", secretName,
      `--project=${projectId}`,
      "--data-file=-",
      "--quiet",
    ], { input: value, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw new Error(`${secretName}: version add failed; credential value was not logged`);
  }
  console.log(`${secretName}: added one version`);
}
