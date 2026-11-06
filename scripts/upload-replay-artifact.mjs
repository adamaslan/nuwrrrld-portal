#!/usr/bin/env node
/**
 * Uploads the wrapped historical-replay artifact to the dedicated
 * replay_artifact table (the loader's REPLAY_ARTIFACT_SOURCE=db source).
 * Core logic and safety contract: scripts/lib/replay-artifact-upload.mjs.
 *
 * Usage: node scripts/upload-replay-artifact.mjs [--check] [path]
 *   --check    validate the file only; no DATABASE_URL needed, no DB access
 *   Unknown arguments are rejected before any file or database access.
 *   This tooling NEVER overwrites: a differing existing row aborts (remove it
 *   by hand with the documented DELETE if replacement is truly intended).
 *
 * Env: DATABASE_URL (unless --check), REPLAY_ARTIFACT_SHA256 (required pin,
 * verified before any write), REPLAY_ENGINE_SHA256 (optional extra pin check).
 * Prints digests and row metadata only, never artifact content.
 * Rollback: DELETE FROM replay_artifact WHERE id = 'historical-replay'
 * (the loader then reports not_computed), or turn the flag off.
 */
import { stat, readFile } from "node:fs/promises";
import { uploadArtifact, validateArtifactBytes, UploadError } from "./lib/replay-artifact-upload.mjs";

const fail = (msg) => { console.error(`upload-replay-artifact: ${msg}`); process.exit(1); };

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const rest = args.filter((a) => a !== "--check");
const unknownFlags = rest.filter((a) => a.startsWith("--"));
if (unknownFlags.length > 0) fail(`unknown argument(s): ${unknownFlags.join(", ")}`);
if (rest.length > 1) fail(`unexpected extra argument(s): ${rest.slice(1).join(", ")}`);
const file = rest[0] ?? "data/replay/historical-replay.json";

const pin = process.env.REPLAY_ARTIFACT_SHA256;
if (!pin) fail("REPLAY_ARTIFACT_SHA256 is required (the loader's server-side pin)");
const engineHash = process.env.REPLAY_ENGINE_SHA256;

const info = await stat(file).catch(() => null);
if (!info?.isFile()) fail(`artifact not a regular file: ${file}`);
const body = await readFile(file, "utf8");

let digest, bytes;
try {
  ({ digest, bytes } = validateArtifactBytes(body, { pin, engineHash }));
} catch (err) {
  fail(err instanceof UploadError ? err.message : String(err));
}
console.log(`verified: ${file} (${bytes} bytes) sha256=${digest}${engineHash ? " engine=ok" : ""}`);
if (checkOnly) { console.log("--check: no database access performed"); process.exit(0); }

if (!process.env.DATABASE_URL) fail("DATABASE_URL is required (omit it only with --check)");
const { neon } = await import("@neondatabase/serverless");
const sql = neon(process.env.DATABASE_URL);

try {
  const result = await uploadArtifact({ sql, body, pin, engineHash });
  console.log(`${result.outcome}: id=historical-replay bytes=${result.bytes} sha256=${result.sha256}`);
} catch (err) {
  fail(err instanceof UploadError ? `[${err.code}] ${err.message}` : String(err));
}
