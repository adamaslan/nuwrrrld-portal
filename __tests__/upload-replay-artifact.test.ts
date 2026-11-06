import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { REPLAY_ARTIFACT_DB_ID, REPLAY_SEED_SHA256 } from "@/lib/historical-replay-store";
import {
  ARTIFACT_ID,
  MAX_ARTIFACT_BYTES,
  REPLAY_SEED_SHA256 as SCRIPT_SEED_SHA256,
  uploadArtifact,
  validateArtifactBytes,
} from "../scripts/lib/replay-artifact-upload.mjs";

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const engineHash = "b".repeat(64);

function makeBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ manifest: { seed_sha256: REPLAY_SEED_SHA256, engine_source_sha256: engineHash, ...extra } });
}
const BODY = makeBody();
const PIN = sha256Hex(BODY);

/** In-memory replay_artifact fake for the neon tagged-template driver. */
function makeFakeDb(opts: { existingBody?: string; tableExists?: boolean; tamperAfterWrite?: boolean; raceBody?: string } = {}) {
  const state = { tableExists: opts.tableExists ?? true, row: opts.existingBody !== undefined ? { body: opts.existingBody } : null as null | { body: string } };
  const log: string[] = [];
  let written = false;
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join("?");
    if (q.includes("CREATE TABLE IF NOT EXISTS replay_artifact")) { state.tableExists = true; log.push("create"); return []; }
    if (q.includes("INSERT INTO replay_artifact")) {
      if (opts.raceBody !== undefined) state.row = { body: opts.raceBody }; // racer lands first
      if (!state.row) { state.row = { body: values[1] as string }; log.push("insert"); written = true; return [{ id: values[0] }]; }
      log.push("insert-conflict-nothing");
      return []; // ON CONFLICT DO NOTHING: RETURNING yields no row
    }
    if (q.includes("SELECT body, octet_length(body)")) {
      if (!state.tableExists) { log.push("select-42P01"); throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); }
      log.push("select");
      if (!state.row) return [];
      let body = state.row.body;
      if (opts.tamperAfterWrite && written) { body = body + "X"; opts.tamperAfterWrite = false; } // corrupt one post-write readback
      return [{ body, byte_len: Buffer.byteLength(body, "utf8") }];
    }
    throw new Error(`unexpected query: ${q}`);
  };
  return { sql, state, log };
}

describe("validateArtifactBytes", () => {
  it("accepts the pinned bytes and returns UTF-8 octet count (unicode)", () => {
    const body = makeBody({ note: "héllo 世界 🚀" });
    const { bytes, digest } = validateArtifactBytes(body, { pin: sha256Hex(body), engineHash });
    expect(bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(bytes).toBeGreaterThan(body.length); // multi-byte proof: octets != chars
    expect(digest).toBe(sha256Hex(body));
  });
  it("refuses a digest mismatch before any DB access", () => {
    expect(() => validateArtifactBytes(BODY, { pin: "0".repeat(64) })).toThrowError(/digest_mismatch|!= pinned/);
  });
  it("requires the pin", () => {
    expect(() => validateArtifactBytes(BODY, {})).toThrowError(/pin is required/);
  });
  it("rejects non-JSON and a missing manifest envelope", () => {
    expect(() => validateArtifactBytes("{nope", { pin: sha256Hex("{nope") })).toThrowError(/not valid JSON/);
    const bare = JSON.stringify({ nope: true });
    expect(() => validateArtifactBytes(bare, { pin: sha256Hex(bare) })).toThrowError(/manifest/);
  });
  it("rejects a wrong embedded seed hash", () => {
    const body = makeBody({ seed_sha256: "0".repeat(64) });
    // note: makeBody spread overrides seed_sha256
    expect(() => validateArtifactBytes(body, { pin: sha256Hex(body) })).toThrowError(/!= pinned seed/);
  });
  it("enforces the engine hash only when supplied", () => {
    expect(() => validateArtifactBytes(BODY, { pin: PIN, engineHash: "0".repeat(64) })).toThrowError(/!= REPLAY_ENGINE_SHA256/);
    expect(() => validateArtifactBytes(BODY, { pin: PIN })).not.toThrow();
  });
  it("rejects oversize artifacts", () => {
    const big = "x".repeat(MAX_ARTIFACT_BYTES + 1);
    expect(() => validateArtifactBytes(big, { pin: sha256Hex(big) })).toThrowError(/too large/);
  });
});

describe("uploadArtifact (insert-or-noop only; never overwrites)", () => {
  it("fresh upload: preflight miss, create, insert, independent readback verify", async () => {
    const db = makeFakeDb({ tableExists: false });
    const res = await uploadArtifact({ sql: db.sql, body: BODY, pin: PIN, engineHash });
    expect(res).toEqual({ outcome: "inserted", sha256: PIN, bytes: Buffer.byteLength(BODY, "utf8") });
    expect(db.log).toEqual(["select-42P01", "create", "insert", "select"]);
    expect(db.state.row?.body).toBe(BODY);
  });
  it("identical rerun is a no-op: no write statements, row untouched", async () => {
    const db = makeFakeDb({ existingBody: BODY });
    const res = await uploadArtifact({ sql: db.sql, body: BODY, pin: PIN });
    expect(res.outcome).toBe("noop");
    expect(db.log).toEqual(["select"]); // preflight only
  });
  it("unicode end-to-end: insert then identical rerun no-op, octet length matches", async () => {
    const body = makeBody({ note: "世界 🚀 héllo" });
    const db = makeFakeDb({ tableExists: false });
    const first = await uploadArtifact({ sql: db.sql, body, pin: sha256Hex(body) });
    expect(first.outcome).toBe("inserted");
    expect(first.bytes).toBe(Buffer.byteLength(body, "utf8"));
    const second = await uploadArtifact({ sql: db.sql, body, pin: sha256Hex(body) });
    expect(second.outcome).toBe("noop");
  });
  it("a DIFFERENT existing artifact always aborts and issues no writes (no replace path exists)", async () => {
    const db = makeFakeDb({ existingBody: makeBody({ note: "other artifact" }) });
    await expect(uploadArtifact({ sql: db.sql, body: BODY, pin: PIN })).rejects.toMatchObject({ code: "conflict" });
    expect(db.log).toEqual(["select"]);
    expect(db.state.row?.body).toBe(makeBody({ note: "other artifact" }));
  });
  it("concurrent writer lands IDENTICAL bytes mid-insert: ON CONFLICT no-op detected via RETURNING, reported as noop", async () => {
    const db = makeFakeDb({ tableExists: true, raceBody: BODY });
    const res = await uploadArtifact({ sql: db.sql, body: BODY, pin: PIN });
    expect(res.outcome).toBe("noop"); // honestly NOT "inserted": our insert did nothing
    expect(db.log).toEqual(["select", "create", "insert-conflict-nothing", "select"]);
  });
  it("concurrent writer lands DIFFERENT bytes mid-insert: conflict, racer's row untouched", async () => {
    const racer = makeBody({ note: "racer" });
    const db = makeFakeDb({ tableExists: true, raceBody: racer });
    await expect(uploadArtifact({ sql: db.sql, body: BODY, pin: PIN })).rejects.toMatchObject({ code: "conflict_after_race" });
    expect(db.state.row?.body).toBe(racer);
  });
  it("tampered readback after our insert: conflict_after_race, row left untouched, nothing deleted", async () => {
    const db = makeFakeDb({ tableExists: false, tamperAfterWrite: true });
    await expect(uploadArtifact({ sql: db.sql, body: BODY, pin: PIN })).rejects.toMatchObject({ code: "conflict_after_race" });
    expect(db.state.row?.body).toBe(BODY); // our row, not deleted
    expect(db.log).not.toContain("restore");
  });
});

describe("CLI argument safety", () => {
  it("rejects unknown flags before any file or database access (--chek must never write)", () => {
    const res = spawnSync(process.execPath, ["scripts/upload-replay-artifact.mjs", "--chek"], {
      cwd: process.cwd(),
      env: { ...process.env, REPLAY_ARTIFACT_SHA256: PIN, DATABASE_URL: "postgres://unused" },
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/unknown argument\(s\): --chek/);
    expect(res.stderr).not.toMatch(/verified:/); // never reached file validation
  });
  it("rejects extra positional arguments", () => {
    const res = spawnSync(process.execPath, ["scripts/upload-replay-artifact.mjs", "--check", "a.json", "b.json"], {
      cwd: process.cwd(),
      env: { ...process.env, REPLAY_ARTIFACT_SHA256: PIN },
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/unexpected extra argument/);
  });
});

describe("parity with the loader", () => {
  it("script constants mirror the store constants", () => {
    expect(ARTIFACT_ID).toBe(REPLAY_ARTIFACT_DB_ID);
    expect(SCRIPT_SEED_SHA256).toBe(REPLAY_SEED_SHA256);
    const storeSrc = readFileSync(path.join(process.cwd(), "lib", "historical-replay-store.ts"), "utf8");
    expect(storeSrc).toContain("8 * 1024 * 1024");
    expect(MAX_ARTIFACT_BYTES).toBe(8 * 1024 * 1024);
  });
});
