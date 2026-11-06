/**
 * Core logic for scripts/upload-replay-artifact.mjs, separated so vitest can
 * exercise it with a fake sql tag. Plain .mjs: also imported by the CLI, which
 * must run under plain node on the owning host (like scripts/hydrate-dev.mjs).
 *
 * Safety contract:
 * - validateArtifactBytes runs BEFORE any database access: byte cap, the
 *   loader's REPLAY_ARTIFACT_SHA256 pin over the exact wrapped bytes, JSON
 *   envelope shape, the code-pinned seed hash, and (when supplied) the engine
 *   hash. Anything short fails closed with no write.
 * - Preflight read before writing: an identical existing row is a no-op
 *   (updated_at untouched, no write statement issued); a DIFFERENT existing
 *   row ALWAYS aborts - there is deliberately no replace/overwrite path in
 *   this tooling (publishing a new artifact means publishing new bytes with a
 *   new pin, and removal is the documented DELETE rollback, done by hand).
 * - Insert uses ON CONFLICT (id) DO NOTHING RETURNING id so an actual insert
 *   is distinguished from a concurrent-writer no-op: a raced IDENTICAL row
 *   reports "noop", a raced DIFFERENT row aborts and is left untouched.
 * - Post-insert verification reads the STORED BODY BACK and digests it
 *   client-side, comparing byte length via octet_length (UTF-8 bytes), never
 *   trusting the sha256 column written by the same statement.
 * - No multi-statement transaction is claimed: each statement is individually
 *   atomic. After our own insert the only writers are concurrent ones, so a
 *   post-write row whose digest is not ours is left UNTOUCHED (it is not
 *   provably ours to delete) and reported as a conflict.
 */
import { createHash } from "node:crypto";

export const ARTIFACT_ID = "historical-replay"; // mirrors REPLAY_ARTIFACT_DB_ID in lib/historical-replay-store.ts (parity-tested)
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024; // mirrors lib/historical-replay-store.ts (parity-tested)
export const REPLAY_SEED_SHA256 = "fe8b1e54f42d54cb48f0bcff573e5b45c48dcacebc4233bd31e41009667b74f8"; // mirrors lib/historical-replay-store.ts (parity-tested)

export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UploadError";
    this.code = code;
  }
}

const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const isMissingTable = (err) => err?.code === "42P01";

/** Validates artifact bytes before any database access. Returns { bytes, digest }.
 * @param {string} body
 * @param {{ pin?: string, engineHash?: string }} [opts]
 * @returns {{ bytes: number, digest: string }}
 */
export function validateArtifactBytes(body, { pin, engineHash } = {}) {
  if (typeof body !== "string" || body.length === 0) throw new UploadError("invalid", "artifact body must be a non-empty string");
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) throw new UploadError("invalid", `artifact too large (${bytes} bytes > ${MAX_ARTIFACT_BYTES})`);
  if (!pin) throw new UploadError("invalid", "REPLAY_ARTIFACT_SHA256 pin is required");
  const digest = sha256Hex(body);
  if (digest !== String(pin).toLowerCase()) {
    throw new UploadError("digest_mismatch", `artifact sha256 ${digest} != pinned ${String(pin).toLowerCase()} - refusing to upload bytes the loader would reject`);
  }
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new UploadError("invalid", "artifact is not valid JSON");
  }
  const manifest = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope.manifest : undefined;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new UploadError("invalid", "artifact envelope must be an object with a manifest object");
  }
  if (manifest.seed_sha256 !== REPLAY_SEED_SHA256) {
    throw new UploadError("seed_mismatch", `manifest.seed_sha256 ${manifest.seed_sha256 ?? "(missing)"} != pinned seed ${REPLAY_SEED_SHA256}`);
  }
  if (engineHash && manifest.engine_source_sha256 !== engineHash) {
    throw new UploadError("engine_mismatch", `manifest.engine_source_sha256 ${manifest.engine_source_sha256 ?? "(missing)"} != REPLAY_ENGINE_SHA256 ${engineHash}`);
  }
  return { bytes, digest };
}

/**
 * Uploads the singleton artifact row: fresh insert or identical no-op ONLY.
 * A differing existing row always aborts; there is no overwrite path.
 * Throws UploadError on conflict or verification failure.
 * @param {{ sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>, body: string, pin: string, engineHash?: string }} args
 * @returns {Promise<{ outcome: "noop" | "inserted", sha256: string, bytes: number }>}
 */
export async function uploadArtifact({ sql, body, pin, engineHash }) {
  const { bytes, digest } = validateArtifactBytes(body, { pin, engineHash });

  // Preflight: what, if anything, already lives at the singleton id?
  let prior = null;
  try {
    const rows = await sql`SELECT body, octet_length(body) AS byte_len FROM replay_artifact WHERE id = ${ARTIFACT_ID}`;
    if (rows.length > 0) prior = rows[0];
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  if (prior) {
    const priorDigest = typeof prior.body === "string" ? sha256Hex(prior.body) : null;
    if (priorDigest === digest) return { outcome: "noop", sha256: digest, bytes };
    throw new UploadError("conflict", `existing row holds a DIFFERENT artifact (sha256 ${priorDigest}); this tooling never overwrites - remove it by hand (documented DELETE) if that is truly intended`);
  }

  await sql`CREATE TABLE IF NOT EXISTS replay_artifact (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

  // RETURNING distinguishes our actual insert from an ON CONFLICT no-op.
  const inserted = await sql`INSERT INTO replay_artifact (id, body, sha256) VALUES (${ARTIFACT_ID}, ${body}, ${digest}) ON CONFLICT (id) DO NOTHING RETURNING id`;

  // Independent readback: digest the STORED BODY client-side, bytes via octet_length.
  const back = await sql`SELECT body, octet_length(body) AS byte_len FROM replay_artifact WHERE id = ${ARTIFACT_ID}`;
  const row = back[0];
  const storedDigest = row && typeof row.body === "string" ? sha256Hex(row.body) : null;
  const verified = storedDigest === digest && Number(row?.byte_len) === bytes;

  if (inserted.length === 0) {
    // A concurrent writer beat us between preflight and insert.
    if (verified) return { outcome: "noop", sha256: digest, bytes }; // identical bytes landed anyway
    throw new UploadError("conflict_after_race", `a concurrent writer holds the row (sha256 ${storedDigest}); left untouched`);
  }
  if (verified) return { outcome: "inserted", sha256: digest, bytes };
  if (!row) throw new UploadError("verify_failed", "post-insert readback found no row; our insert was apparently removed by a concurrent actor - nothing of ours remains");
  throw new UploadError("conflict_after_race", `post-insert readback shows a different artifact (sha256 ${storedDigest}); left untouched - a concurrent actor changed it after our insert`);
}
