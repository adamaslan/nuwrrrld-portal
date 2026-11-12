import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadHistoricalReplay, REPLAY_SEED_SHA256 } from "@/lib/historical-replay-store";
// Synthetic full-universe contract fixture (fabricated values; generated to
// exercise the reader end to end). The REAL runner artifacts - including the
// old 7-complete run and the current 954-ticker run - are private research
// data and must never be committed; they live only under gitignored
// data/replay/ on the owning host.
import fixtureManifest from "./fixtures/historical-replay-manifest.fixture.json";

const engineHash = "b".repeat(64);
const manifest = {
  mode: "reconstructed_point_in_time", decision_start: "2025-11-06", observation_cutoff: "2026-11-05", computed_at: "2026-11-06T05:00:00Z",
  seed_sha256: REPLAY_SEED_SHA256, engine_source_sha256: engineHash, warmup_bars: 200, price_return_only: true,
  source: { source: "FIXTURE, not historical returns", adjustment: "fixture", calendar_policy: "fixture", retrieved_at: "2026-11-06T05:00:00Z" },
  mixed_input_basis: false, basis_policy: "single declared price basis",
  signal_suitability_policy: "fixture policy", distinct_input_bases: [{ id: "basis-0", source: "FIXTURE", adjustment: "fixture" }],
  horizons_observed_bars: [1, 5], requested_tickers: 954,
  ledger: [{ ticker: "AAPL", status: "ok", warmup_available: 250, decision_bars: 251, expected_decision_bars: 251, missing_decision_dates: [], unexpected_decision_dates: [], input_sha256: "c".repeat(64), first_decision: "2025-11-06", last_decision: "2026-11-05" }, { ticker: "BTC-USD", status: "missing_history" }],
  pooled_category_strength_horizon: [{ basis: "basis-0", category: "MACD", strength: "BULLISH", horizon_bars: 5, hits: 20, misses: 9, flat: 1, pending: 5, resolved_directional: 30, hit_rate: 20 / 30 }],
};
const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const anchorsFor = (body: string) => ({ engineHash, artifactSha256: sha256Hex(body) });
const now = () => new Date("2026-11-06T12:00:00Z");

describe("historical replay artifact loader", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "replay-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const put = async (body: string, name = "a.json") => { const f = path.join(dir, name); await writeFile(f, body); return f; };

  it("fails closed when server provenance anchors are not configured", async () => {
    const body = JSON.stringify({ manifest });
    const res = await loadHistoricalReplay(await put(body), now, {});
    if (res.status !== "invalid_run") throw new Error("expected invalid_run");
    expect(res.reason).toMatch(/anchors not configured/);
  });
  it("treats a missing artifact as not computed, not an error", async () => {
    expect(await loadHistoricalReplay(path.join(dir, "absent.json"), now, anchorsFor("x")))
      .toEqual({ status: "not_computed", view: null });
  });
  it("rejects non-JSON and malformed envelopes without throwing", async () => {
    const bad1 = "{nope";
    expect((await loadHistoricalReplay(await put(bad1), now, anchorsFor(bad1))).status).toBe("invalid_run");
    const bad2 = JSON.stringify({ nope: true });
    expect((await loadHistoricalReplay(await put(bad2), now, anchorsFor(bad2))).status).toBe("invalid_run");
  });
  it("artifact-supplied tickers and anchors carry no authority: only server truth binds", async () => {
    // An artifact attesting garbage anchors and a fake 1-ticker universe must
    // still validate against the SERVER universe (954) and pinned anchors.
    const { readFile } = await import("node:fs/promises");
    const csv = await readFile(path.join(process.cwd(), "lib", "replay", "universe_symbols.csv"), "utf8");
    const universe = csv.split("\n").slice(1).map((l) => l.split(",")[0]?.trim().toUpperCase()).filter(Boolean);
    const okRow = manifest.ledger[0];
    const fullLedger = universe.map((t) => (t === "AAPL" ? okRow : { ticker: t, status: "missing_history" }));
    const full = { ...manifest, ledger: fullLedger };
    const body = JSON.stringify({ expected: { tickers: ["AAPL"], seedHash: "0".repeat(64), engineHash: "0".repeat(64) }, manifest: full });
    const res = await loadHistoricalReplay(await put(body), now, anchorsFor(body));
    expect(res.status).toBe("partial");
    expect(res.view?.requested).toBe(954);
    expect(res.view?.complete).toBe(1);
    expect(res.view?.missing).toBe(953);
    expect(res.view?.productionPriorEligible).toBe(false);
    expect(res.view?.label).toMatch(/not a live track record/);
  });
  it("a manifest whose real engine hash mismatches the server anchor is invalid", async () => {
    const body = JSON.stringify({ manifest });
    const res = await loadHistoricalReplay(await put(body), now, { engineHash: "d".repeat(64), artifactSha256: sha256Hex(body) });
    expect(res.status).toBe("invalid_run");
  });
  it("an artifact whose content digest is not the pinned one is invalid", async () => {
    const body = JSON.stringify({ manifest });
    expect((await loadHistoricalReplay(await put(body), now, { engineHash, artifactSha256: "e".repeat(64) })).status).toBe("invalid_run");
  });
  it("rejects symlinks and oversize artifacts", async () => {
    const body = JSON.stringify({ manifest });
    const real = await put(body, "real.json");
    const link = path.join(dir, "link.json");
    await symlink(real, link);
    const linked = await loadHistoricalReplay(link, now, anchorsFor(body));
    if (linked.status !== "invalid_run") throw new Error("expected invalid_run");
    expect(linked.reason).toMatch(/symlink|unreadable/);
    const big = await put(" ".repeat(8 * 1024 * 1024 + 1), "big.json");
    const oversize = await loadHistoricalReplay(big, now, anchorsFor("unused"));
    if (oversize.status !== "invalid_run") throw new Error("expected invalid_run");
    expect(oversize.reason).toMatch(/too large/);
  });
  it("a manifest dated after today is invalid (no future-dated research)", async () => {
    const body = JSON.stringify({ manifest });
    const early = () => new Date("2026-11-04T00:00:00Z");
    expect((await loadHistoricalReplay(await put(body), early, anchorsFor(body))).status).toBe("invalid_run");
  });
  it("canonical seed file is intact and parses to the pinned universe", async () => {
    const { readFile } = await import("node:fs/promises");
    const csv = await readFile(path.join(process.cwd(), "lib", "replay", "universe_symbols.csv"), "utf8");
    expect(sha256Hex(csv)).toBe(REPLAY_SEED_SHA256);
    const tickers = csv.split("\n").slice(1).map((l) => l.split(",")[0]?.trim().toUpperCase()).filter(Boolean);
    expect(tickers).toHaveLength(954);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("BTC-USD");
    expect(tickers).toContain("VTSAX");
  });
  it("parses a full-universe synthetic manifest end to end (contract proof)", async () => {
    // 954 ledger rows over the canonical seed universe with fabricated
    // counts: 6 ok, 2 partial_calendar_coverage + 1 insufficient_warmup
    // (partial), 1 error, 1 unsupported, 943 missing_history, 36 buckets.
    const body = JSON.stringify({ manifest: fixtureManifest });
    const res = await loadHistoricalReplay(await put(body), now, {
      engineHash: fixtureManifest.engine_source_sha256,
      artifactSha256: sha256Hex(body),
    });
    expect(res.status).toBe("partial");
    expect(res.view?.requested).toBe(954);
    expect(res.view?.complete).toBe(6);
    expect(res.view?.partial).toBe(3);
    expect(res.view?.errors).toBe(1);
    expect(res.view?.missing).toBe(943);
    expect(res.view?.unsupported).toBe(1);
    expect(res.view?.mixedInputBasis).toBe(true);
    expect(res.view?.buckets.length).toBe(36);
    expect(res.view?.productionPriorEligible).toBe(false);
  });
});

describe("GET /api/research/historical-replay", () => {
  const authMock = vi.fn();
  const currentUserMock = vi.fn();
  const flagMock = vi.fn();
  const loadMock = vi.fn();
  const adminUser = {
    primaryEmailAddressId: "e1",
    emailAddresses: [{ id: "e1", emailAddress: "owner@example.com", verification: { status: "verified" } }],
  };
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset(); currentUserMock.mockReset(); flagMock.mockReset(); loadMock.mockReset();
    vi.doMock("@clerk/nextjs/server", () => ({ auth: authMock, currentUser: currentUserMock }));
    vi.doMock("@/lib/flags", () => ({ flagLive: flagMock }));
    vi.doMock("@/lib/historical-replay-store", () => ({ loadHistoricalReplay: loadMock }));
    process.env.NULOGDASH_ADMIN_EMAILS = "owner@example.com,other-admin@example.com";
    process.env.NULOGDASH_REPLAY_OWNER_EMAILS = "owner@example.com";
  });
  afterEach(() => {
    vi.doUnmock("@clerk/nextjs/server"); vi.doUnmock("@/lib/flags"); vi.doUnmock("@/lib/historical-replay-store");
    delete process.env.NULOGDASH_ADMIN_EMAILS;
    delete process.env.NULOGDASH_REPLAY_OWNER_EMAILS;
  });

  it("is 204 and reads nothing while the dark-launch flag is off", async () => {
    flagMock.mockReturnValue(false);
    const { GET } = await import("@/app/api/research/historical-replay/route");
    const res = await GET();
    expect(res.status).toBe(204);
    expect(authMock).not.toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });
  it("is 401 for a signed-out caller when the flag is live", async () => {
    flagMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: null });
    const { GET } = await import("@/app/api/research/historical-replay/route");
    expect((await GET()).status).toBe(401);
    expect(loadMock).not.toHaveBeenCalled();
  });
  it("is 403 for a signed-in NON-admin: any user is not enough for private research", async () => {
    flagMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u1" });
    currentUserMock.mockResolvedValue({
      primaryEmailAddressId: "e1",
      emailAddresses: [{ id: "e1", emailAddress: "stranger@example.com", verification: { status: "verified" } }],
    });
    const { GET } = await import("@/app/api/research/historical-replay/route");
    expect((await GET()).status).toBe(403);
    expect(loadMock).not.toHaveBeenCalled();
  });
  it("is 403 for a shared-allowlist ADMIN who is not the replay owner (artifact is owner-private)", async () => {
    flagMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u2" });
    currentUserMock.mockResolvedValue({
      primaryEmailAddressId: "e1",
      emailAddresses: [{ id: "e1", emailAddress: "other-admin@example.com", verification: { status: "verified" } }],
    });
    const { GET } = await import("@/app/api/research/historical-replay/route");
    expect((await GET()).status).toBe(403);
    expect(loadMock).not.toHaveBeenCalled();
  });
  it("is 403 when the replay-owner allowlist is unset even for an admin (fails closed)", async () => {
    delete process.env.NULOGDASH_REPLAY_OWNER_EMAILS;
    flagMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u1" });
    currentUserMock.mockResolvedValue(adminUser);
    const { GET } = await import("@/app/api/research/historical-replay/route");
    expect((await GET()).status).toBe(403);
    expect(loadMock).not.toHaveBeenCalled();
  });
  it("returns the loader result uncached for an admin when live", async () => {
    flagMock.mockReturnValue(true);
    authMock.mockResolvedValue({ userId: "u1" });
    currentUserMock.mockResolvedValue(adminUser);
    loadMock.mockResolvedValue({ status: "not_computed", view: null });
    const { GET } = await import("@/app/api/research/historical-replay/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ status: "not_computed", view: null });
  });
});
