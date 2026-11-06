/**
 * Server-side loader for the reconstructed historical-replay research artifact.
 *
 * Trust model (hardened after independent review):
 * - Provenance anchors come from the SERVER, never from the artifact: an
 *   artifact that pins its own anchors can attest anything.
 *   - Seed: the canonical ticker universe is the committed, reviewed seed file
 *     lib/replay/universe_symbols.csv. Its bytes are hashed at load and must
 *     equal the code-pinned REPLAY_SEED_SHA256, and the expected ticker list
 *     the manifest's ledger is checked against is parsed from that file.
 *     Artifact-supplied ticker lists carry no authority.
 *   - Engine: REPLAY_ENGINE_SHA256 env, required, fails closed.
 *   - Artifact integrity: REPLAY_ARTIFACT_SHA256 env pins the exact published
 *     artifact bytes (content digest); unset or mismatched fails closed.
 * - One aggregate JSON file: { "manifest": ... } (an "expected" field is
 *   tolerated but ignored). Ledger rows and pooled buckets only - no prices,
 *   no per-ticker detail.
 * - Source: REPLAY_ARTIFACT_SOURCE selects where the artifact bytes come
 *   from. Unset or "file" (default): REPLAY_ARTIFACT_PATH, default
 *   data/replay/historical-replay.json under the app root. Never committed
 *   (see .gitignore). On serverless deploys process.cwd() and a readable
 *   artifact path are not guaranteed; set REPLAY_ARTIFACT_PATH to a mounted
 *   location before flipping the flag. "db": the singleton row of the
 *   dedicated replay_artifact table (id "historical-replay"), written only by
 *   scripts/upload-replay-artifact.mjs. Any other value fails closed.
 *   The source is ONLY a byte transport: REPLAY_ARTIFACT_SHA256 pins the
 *   exact wrapped bytes either way and the digest is verified after the
 *   read, so a tampered file and a tampered row fail identically.
 * - The "db" branch lazy-imports @/lib/db inside the request path, so
 *   importing this module adds no DATABASE_URL requirement at build time and
 *   no artifact DB read ever happens at build/collect time. The read path
 *   issues no DDL: a missing table or row is "not_computed", never an error.
 *   Rollback is the flag (OFF = nothing is read) or deleting the row; the
 *   empty table itself is inert.
 * - File source is opened O_NOFOLLOW and fstat'd: symlinks, non-regular
 *   files and oversize artifacts are rejected. Both sources reject bodies
 *   over MAX_ARTIFACT_BYTES. A missing file is "not_computed".
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { readHistoricalReplay, type ReplayReadResult } from "@/lib/shared/historical-replay-view";

export const REPLAY_ARTIFACT_DEFAULT = path.join("data", "replay", "historical-replay.json");

/** Aggregate JSON only; the real 954-row artifact is about 230 KB. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/** Canonical universe seed, committed and review-gated. Traced into the
 *  standalone build via outputFileTracingIncludes in next.config.ts. */
const SEED_FILE = path.join(process.cwd(), "lib", "replay", "universe_symbols.csv");

/** sha256 of the canonical seed file bytes. Changing the universe means
 *  changing the file AND this pin in the same reviewed commit. */
export const REPLAY_SEED_SHA256 = "fe8b1e54f42d54cb48f0bcff573e5b45c48dcacebc4233bd31e41009667b74f8";

const invalid = (reason: string): ReplayReadResult => ({ status: "invalid_run", view: null, reason });
const NOT_COMPUTED: ReplayReadResult = { status: "not_computed", view: null };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Ticker is the first CSV field and never contains a comma, so a first-comma
 *  split is sufficient for this file; quoted later fields are irrelevant. */
function parseSeedTickers(csv: string): string[] {
  return Array.from(new Set(csv
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[0]?.trim().toUpperCase() ?? "")
    .filter((t) => t.length > 0)));
}

/** Primary key of the singleton artifact row when REPLAY_ARTIFACT_SOURCE=db. */
export const REPLAY_ARTIFACT_DB_ID = "historical-replay";

type ArtifactSource = "file" | "db";

function artifactSource(): ArtifactSource | ReplayReadResult {
  const configured = process.env.REPLAY_ARTIFACT_SOURCE;
  if (configured === undefined || configured === "" || configured === "file") return "file";
  if (configured === "db") return "db";
  return invalid("artifact source misconfigured");
}

/** Reads the singleton artifact row. Read-only: no DDL, no writes - the table
 *  is created and written exclusively by scripts/upload-replay-artifact.mjs.
 *  @/lib/db is imported lazily so this module never requires DATABASE_URL at
 *  build time (lib/db.ts evaluates neon() on import). */
async function readArtifactFromDb(): Promise<{ raw: string } | ReplayReadResult> {
  let rows: { body?: unknown }[];
  try {
    const { default: sql } = await import("@/lib/db");
    rows = (await sql`SELECT body FROM replay_artifact WHERE id = ${REPLAY_ARTIFACT_DB_ID}`) as { body?: unknown }[];
  } catch (err) {
    // 42P01 = undefined table: the upload step has never run on this database.
    if ((err as { code?: string } | null)?.code === "42P01") return NOT_COMPUTED;
    return invalid("artifact unreadable");
  }
  if (rows.length === 0) return NOT_COMPUTED;
  const body = rows[0]?.body;
  if (typeof body !== "string") return invalid("artifact row malformed");
  if (Buffer.byteLength(body, "utf8") > MAX_ARTIFACT_BYTES) return invalid("artifact too large");
  return { raw: body };
}

async function expectedTickers(): Promise<string[] | ReplayReadResult> {
  let csv: string;
  try {
    csv = await readFile(SEED_FILE, "utf8");
  } catch {
    return invalid("canonical seed file unavailable");
  }
  if (sha256Hex(csv) !== REPLAY_SEED_SHA256) return invalid("canonical seed file does not match the pinned hash");
  return parseSeedTickers(csv);
}

export async function loadHistoricalReplay(
  file: string = process.env.REPLAY_ARTIFACT_PATH ?? path.join(process.cwd(), REPLAY_ARTIFACT_DEFAULT),
  now: () => Date = () => new Date(),
  anchors: { engineHash?: string; artifactSha256?: string } = {
    engineHash: process.env.REPLAY_ENGINE_SHA256,
    artifactSha256: process.env.REPLAY_ARTIFACT_SHA256,
  },
): Promise<ReplayReadResult> {
  if (!anchors.engineHash || !anchors.artifactSha256) return invalid("server provenance anchors not configured");
  const source = artifactSource();
  if (typeof source !== "string") return source;
  let raw: string;
  if (source === "db") {
    const res = await readArtifactFromDb();
    if (!("raw" in res)) return res;
    raw = res.raw;
  } else {
    try {
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stats = await handle.stat();
        if (!stats.isFile()) return invalid("artifact is not a regular file");
        if (stats.size > MAX_ARTIFACT_BYTES) return invalid("artifact too large");
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return NOT_COMPUTED;
      if (code === "ELOOP") return invalid("artifact must not be a symlink");
      return invalid("artifact unreadable");
    }
  }
  if (sha256Hex(raw) !== anchors.artifactSha256.toLowerCase()) return invalid("artifact content digest does not match the pinned server anchor");
  const tickers = await expectedTickers();
  if (!Array.isArray(tickers)) return tickers;
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return invalid("artifact is not valid JSON");
  }
  // Only the manifest crosses the trust boundary; any artifact-supplied
  // "expected" block (tickers, hashes) is ignored by construction.
  if (!record(envelope) || !("manifest" in envelope)) return invalid("artifact envelope malformed");
  return readHistoricalReplay(envelope.manifest, {
    tickers,
    seedHash: REPLAY_SEED_SHA256,
    engineHash: anchors.engineHash,
    today: now().toISOString().slice(0, 10),
  });
}
