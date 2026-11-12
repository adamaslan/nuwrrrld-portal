import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tests for the REPLAY_ARTIFACT_SOURCE=db branch of the artifact loader.
 * The DB is only a byte transport: the same REPLAY_ARTIFACT_SHA256 pin and
 * the same envelope/seed/engine validation must apply to row bytes exactly as
 * they apply to file bytes, and every failure mode must fail closed.
 * @/lib/db is mocked; the store must lazy-import it so file-source loads and
 * build-time module graphs never require DATABASE_URL.
 */
const sqlMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ default: sqlMock }));

import { loadHistoricalReplay, REPLAY_SEED_SHA256, REPLAY_ARTIFACT_DB_ID } from "@/lib/historical-replay-store";

const engineHash = "b".repeat(64);
const manifest = {
  mode: "reconstructed_point_in_time", decision_start: "2025-11-06", observation_cutoff: "2026-11-05", computed_at: "2026-11-06T05:00:00Z",
  seed_sha256: REPLAY_SEED_SHA256, engine_source_sha256: engineHash, warmup_bars: 200, price_return_only: true,
  source: { source: "FIXTURE, not historical returns", adjustment: "fixture", calendar_policy: "fixture", retrieved_at: "2026-11-06T05:00:00Z" },
  mixed_input_basis: false, basis_policy: "single declared price basis",
  signal_suitability_policy: "fixture policy", distinct_input_bases: [{ id: "basis-0", source: "FIXTURE", adjustment: "fixture" }],
  horizons_observed_bars: [1, 5], requested_tickers: 954,
  ledger: [{ ticker: "AAPL", status: "ok", warmup_available: 250, decision_bars: 251, expected_decision_bars: 251, missing_decision_dates: [], unexpected_decision_dates: [], input_sha256: "c".repeat(64), first_decision: "2025-11-06", last_decision: "2026-11-05" }],
  pooled_category_strength_horizon: [{ basis: "basis-0", category: "MACD", strength: "BULLISH", horizon_bars: 5, hits: 20, misses: 9, flat: 1, pending: 5, resolved_directional: 30, hit_rate: 20 / 30 }],
};
import { readFileSync } from "node:fs";
const universe = readFileSync(path.join(process.cwd(), "lib", "replay", "universe_symbols.csv"), "utf8")
  .split("\n").slice(1).map((l) => l.split(",")[0]?.trim().toUpperCase()).filter(Boolean);
const fullLedger = universe.map((t) => (t === "AAPL" ? manifest.ledger[0] : { ticker: t, status: "missing_history" }));
const fullManifest = { ...manifest, ledger: fullLedger };
const wrapped = JSON.stringify({ manifest: fullManifest });
const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const anchors = { engineHash, artifactSha256: sha256Hex(wrapped) };
const now = () => new Date("2026-11-06T12:00:00Z");

/** Narrows to the invalid_run variant so .reason is accessible (house idiom). */
function expectInvalid(res: Awaited<ReturnType<typeof loadHistoricalReplay>>, pattern: RegExp) {
  if (res.status !== "invalid_run") throw new Error(`expected invalid_run, got ${res.status}`);
  expect(res.reason).toMatch(pattern);
}

const ORIGINAL_SOURCE = process.env.REPLAY_ARTIFACT_SOURCE;

describe("historical replay loader - db source", () => {
  let dir: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(path.join(tmpdir(), "replay-db-"));
    process.env.REPLAY_ARTIFACT_SOURCE = "db";
    sqlMock.mockResolvedValue([{ body: wrapped }]);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (ORIGINAL_SOURCE === undefined) delete process.env.REPLAY_ARTIFACT_SOURCE;
    else process.env.REPLAY_ARTIFACT_SOURCE = ORIGINAL_SOURCE;
  });

  const missingFile = () => path.join(dir, "absent.json");

  it("loads the singleton row through the same pin + validation pipeline as file bytes", async () => {
    const res = await loadHistoricalReplay(missingFile(), now, anchors);
    expect(res.status).toBe("partial"); // 1 ok ledger row against the 954-ticker seed
    expect(res.view?.requested).toBe(954);
    expect(sqlMock).toHaveBeenCalledTimes(1);
    // The query must target the dedicated table's singleton id.
    const [strings, ...values] = sqlMock.mock.calls[0]!;
    expect(strings.join("?")).toMatch(/FROM replay_artifact WHERE id =/);
    expect(values).toEqual([REPLAY_ARTIFACT_DB_ID]);
  });

  it("ignores the file path entirely when source=db (no file fallback)", async () => {
    // A VALID file sits at the given path; source=db must not read it, and the
    // DB row alone decides the result.
    const other = JSON.stringify({ manifest: { ...manifest, requested_tickers: 954 } });
    const filePath = path.join(dir, "decoy.json");
    await writeFile(filePath, other);
    sqlMock.mockResolvedValue([]); // no row
    const res = await loadHistoricalReplay(filePath, now, { engineHash, artifactSha256: sha256Hex(other) });
    expect(res).toEqual({ status: "not_computed", view: null });
  });

  it("digest mismatch on row bytes fails closed, same as a tampered file", async () => {
    sqlMock.mockResolvedValue([{ body: wrapped }]);
    expectInvalid(await loadHistoricalReplay(missingFile(), now, { engineHash, artifactSha256: "0".repeat(64) }), /digest/);
  });

  it("missing row is not_computed, never an error", async () => {
    sqlMock.mockResolvedValue([]);
    expect(await loadHistoricalReplay(missingFile(), now, anchors)).toEqual({ status: "not_computed", view: null });
  });

  it("missing table (42P01) is not_computed, never an error", async () => {
    sqlMock.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));
    expect(await loadHistoricalReplay(missingFile(), now, anchors)).toEqual({ status: "not_computed", view: null });
  });

  it("other database errors fail closed as unreadable", async () => {
    sqlMock.mockRejectedValue(Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }));
    expectInvalid(await loadHistoricalReplay(missingFile(), now, anchors), /unreadable/);
  });

  it("non-string row body fails closed", async () => {
    sqlMock.mockResolvedValue([{ body: 42 }]);
    expectInvalid(await loadHistoricalReplay(missingFile(), now, anchors), /malformed/);
  });

  it("oversize row body fails closed", async () => {
    sqlMock.mockResolvedValue([{ body: "x".repeat(8 * 1024 * 1024 + 1) }]);
    expectInvalid(await loadHistoricalReplay(missingFile(), now, anchors), /too large/);
  });

  it("unknown source value fails closed before touching file or db", async () => {
    process.env.REPLAY_ARTIFACT_SOURCE = "s3";
    const filePath = path.join(dir, "valid.json");
    await writeFile(filePath, wrapped); // a VALID file exists...
    expectInvalid(await loadHistoricalReplay(filePath, now, anchors), /source misconfigured/);
    expect(sqlMock).not.toHaveBeenCalled(); // ...and neither source was read
  });

  it("unset source keeps file behavior (control)", async () => {
    delete process.env.REPLAY_ARTIFACT_SOURCE;
    const filePath = path.join(dir, "valid.json");
    await writeFile(filePath, wrapped);
    const res = await loadHistoricalReplay(filePath, now, anchors);
    expect(res.status).toBe("partial");
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
