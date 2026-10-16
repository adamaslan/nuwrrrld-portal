#!/usr/bin/env node
/** Copy only named NWF credentials into empty, slot-specific Secret Manager containers. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const [envPath, projectId] = process.argv.slice(2);
if (!envPath || !projectId) {
  console.error("Usage: node infra/sync-shadow-secrets.mjs PATH_TO_NWF_ENV GCP_PROJECT_ID");
  process.exit(2);
}

const names = new Map([
  ["ALPACA_API_KEY", "nwf-shadow-alpaca-api-key"],
  ["ALPACA_API_SECRET", "nwf-shadow-alpaca-api-secret"],
  ["OPENROUTER_API_KEY", "nwf-shadow-openrouter-api-key"],
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
