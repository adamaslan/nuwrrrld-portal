/**
 * Phase 8 of docs/openrouter-migration-and-db-parity-plan.md.
 *
 * Runs each covered lib/*-db.ts module's exported functions against an
 * in-memory SQLite DB built from the generated lib/db/schema.sqlite.sql
 * (Phase 7), proving the module's query strings are SQLite-compatible — the
 * actual failure mode this suite exists to catch: a Postgres-only construct
 * (ON CONFLICT/EXCLUDED, RETURNING, interval math, ::casts) landing in a
 * *-db.ts string that scripts/backup-to-sqlite.mjs's restore path can't
 * replay.
 *
 * Each `describe` block ALSO runs against a real Neon connection when
 * DATABASE_URL is set (CI points this at a throwaway Neon branch — see
 * ci.yml's `db-parity` job) and asserts the two engines agree on shape.
 * Locally, with no DATABASE_URL, the Neon half is skipped and reported —
 * that's expected for a dev sandbox with no Neon credentials, not a failure.
 *
 * NOT covered here — see README.md in this directory for why:
 *   lib/followed-tickers-db.ts, lib/live-price-db.ts, lib/ticker-cards-db.ts
 *   (all use unnest()/ANY(array) bulk-write idioms with no SQLite
 *   equivalent yet), and precomputed-ai-db.ts's listWatchlistSubjects
 *   (uses string_agg(DISTINCT …)).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteSql, loadSchema } from "../../test/db-parity/sqlite-sql-tag";

const hasNeon = !!process.env.DATABASE_URL;

/**
 * Every table a Neon-path `describe` block below reads or writes. The tests
 * assert a fresh/empty starting state (`toBeNull()`, `toHaveLength(0)`, …)
 * and reuse fixed identifiers (`"u1"`, `"k1"`, `"global"`) across runs — safe
 * against SQLite (a brand-new :memory: DB every test) but not against a Neon
 * branch that persists between CI runs: a rerun against the same
 * NEON_BRANCH_DATABASE_URL would find last run's rows still there and fail
 * the fresh-state assertion before it ever gets to checking parity.
 * CodeRabbit review, PR #105.
 */
const NEON_PARITY_TABLES = [
  "signal_digest_cache",
  "user_digest_cache",
  "holdfold_cache",
  "analyze_cache",
  "nuai_usage",
  "council_messages",
  "council_sessions",
  "council_usage",
  "council_verdicts",
  "disclaimer_acks",
  "legal_consent_events",
  "user_attribution",
  "privacy_requests",
  "precomputed_ai",
  "watchlist_items",
] as const;

/** Truncates every table this suite touches on the real Neon branch, before
 *  each test — a no-op when DATABASE_URL isn't set (SQLite tests are already
 *  isolated by using a fresh :memory: DB per test). The branch this points at
 *  is documented as throwaway/CI-only (ci.yml's db-schema-parity job), so a
 *  full per-table clear is safe and simpler than tracking each test's exact
 *  rows. */
beforeEach(async () => {
  if (!hasNeon) return;
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  for (const table of NEON_PARITY_TABLES) {
    await sql.query(`DELETE FROM ${table}`);
  }
});

/** Mocks "@/lib/db" with a fresh in-memory SQLite DB and imports `modulePath`
 *  fresh, so the module's top-level `import sql from "@/lib/db"` binds to it. */
async function loadWithSqlite<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  const db = new DatabaseSync(":memory:");
  loadSchema(db);
  vi.doMock("@/lib/db", () => ({ default: createSqliteSql(db) }));
  return (await import(modulePath)) as T;
}

/** Same, but against the real Neon connection named by DATABASE_URL. Caller
 *  must guard with `if (!hasNeon) return` — see the `describe.skipIf` blocks
 *  below, which skip the whole suite rather than each `it`. */
async function loadWithNeon<T>(modulePath: string): Promise<T> {
  vi.resetModules();
  vi.doMock("@/lib/db", async () => {
    const { neon } = await import("@neondatabase/serverless");
    return { default: neon(process.env.DATABASE_URL!) };
  });
  return (await import(modulePath)) as T;
}

afterEach(() => {
  vi.doUnmock("@/lib/db");
  vi.resetModules();
});

describe("digest-cache-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/digest-cache-db")>("@/lib/digest-cache-db");
    expect(await mod.getLatestDigest()).toBeNull();
    await mod.saveDigest({ periodLabel: "test", generatedAt: new Date().toISOString() } as never);
    expect(await mod.getLatestDigest()).not.toBeNull();

    expect(await mod.getUserDigest("u1")).toBeNull();
    const expiresAt = new Date(Date.now() + 60_000);
    await mod.saveUserDigest("u1", { periodLabel: "test", generatedAt: new Date().toISOString() } as never, expiresAt);
    const userDigest = await mod.getUserDigest("u1");
    expect(userDigest).not.toBeNull();
    expect(userDigest?.digest).toMatchObject({ periodLabel: "test" });
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("holdfold-cache-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/holdfold-cache-db")>("@/lib/holdfold-cache-db");
    expect(await mod.getLatestHoldFoldCache()).toBeNull();
    await mod.saveHoldFoldCache({ verdicts: [] } as never);
    expect(await mod.getLatestHoldFoldCache()).toEqual({ verdicts: [] });
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("analyze-cache-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/analyze-cache-db")>("@/lib/analyze-cache-db");
    expect(await mod.getCachedAnalysis("k1")).toBeNull();
    await mod.saveAnalysis("k1", "AAPL", { ok: true });
    expect(await mod.getCachedAnalysis("k1")).toEqual({ ok: true });
    // ON CONFLICT (cache_key) DO UPDATE — re-save must upsert, not duplicate.
    await mod.saveAnalysis("k1", "AAPL", { ok: false });
    expect(await mod.getCachedAnalysis("k1")).toEqual({ ok: false });
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("nuai-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/nuai-db")>("@/lib/nuai-db");
    expect(await mod.getUsedTokensToday("u1")).toBe(0);
    await mod.addTokenUsage("u1", 100);
    await mod.addTokenUsage("u1", 50);
    // ON CONFLICT ... DO UPDATE SET tokens = nuai_usage.tokens + excluded.tokens
    expect(await mod.getUsedTokensToday("u1")).toBe(150);
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("council-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/council-db")>("@/lib/council-db");
    const sessionId = await mod.createSession("u1", "AAPL");
    expect(sessionId).toBeTruthy();
    await mod.saveMessage(sessionId!, {
      seat: "T1" as never,
      round: 1,
      role: "answer",
      model: "openrouter/qwen3",
      content: "bullish",
    });
    await mod.saveVerdict(sessionId!, "AAPL", {
      direction: "bullish",
      confidence: "high",
      horizon: "1-5d",
      invalidation: "close below 200",
    });
    const recent = await mod.recentVerdicts("AAPL", 3);
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ direction: "bullish" });

    const first = await mod.checkAndBumpQuota("u1", 5);
    expect(first).toMatchObject({ allowed: true, used: 1, limit: 5 });
    const second = await mod.checkAndBumpQuota("u1", 5);
    expect(second).toMatchObject({ allowed: true, used: 2, limit: 5 });
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("disclaimer-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/disclaimer-db")>("@/lib/disclaimer-db");
    expect(await mod.hasAcknowledged("u1", "hash1")).toBe(false);
    await mod.recordAck("u1", "hash1", "v1");
    expect(await mod.hasAcknowledged("u1", "hash1")).toBe(true);
    // ON CONFLICT DO NOTHING — re-recording must not throw.
    await expect(mod.recordAck("u1", "hash1", "v1")).resolves.toBeUndefined();
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("legal-consent-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/legal-consent-db")>("@/lib/legal-consent-db");
    await mod.recordLegalConsent("u1", "tos", "v1");
    await mod.recordLegalConsent("u1", "privacy", "v1");
    const history = await mod.listLegalConsent("u1");
    expect(history).toHaveLength(2);
    // ON CONFLICT (user_id, doc, doc_version) DO NOTHING — re-recording is a no-op.
    await mod.recordLegalConsent("u1", "tos", "v1");
    expect(await mod.listLegalConsent("u1")).toHaveLength(2);
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("attribution-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/attribution-db")>("@/lib/attribution-db");
    expect(await mod.getUserAttribution("u1")).toBeNull();
    await mod.ensureUserAttribution("u1", { utm_source: "x" } as never, null);
    const attrib = await mod.getUserAttribution("u1");
    expect(attrib).not.toBeNull();
    // ON CONFLICT (user_id) DO NOTHING — first-touch must never be overwritten.
    await mod.ensureUserAttribution("u1", { utm_source: "y" } as never, null);
    expect(await mod.getUserAttribution("u1")).toEqual(attrib);
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("privacy-requests-db", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/privacy-requests-db")>("@/lib/privacy-requests-db");
    const id = await mod.logPrivacyRequest({ userId: "u1", kind: "export" });
    expect(id).not.toBeNull();
    await mod.resolvePrivacyRequest(id!, "fulfilled");
    const list = await mod.listPrivacyRequests("u1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "fulfilled", kind: "export" });
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});

describe("precomputed-ai-db (read/write, excluding listWatchlistSubjects)", () => {
  const run = async (loader: <T>(m: string) => Promise<T>) => {
    const mod = await loader<typeof import("@/lib/precomputed-ai-db")>("@/lib/precomputed-ai-db");
    expect(await mod.getPrecomputed("digest_commentary", "global")).toBeNull();
    const ok = await mod.savePrecomputed("digest_commentary", "global", { text: "hi" }, "openrouter/qwen3");
    expect(ok).toBe(true);
    const record = await mod.getPrecomputed("digest_commentary", "global");
    expect(record).toMatchObject({ payload: { text: "hi" }, model: "openrouter/qwen3" });
    // ON CONFLICT (kind, subject) DO UPDATE — upsert, not duplicate.
    await mod.savePrecomputed("digest_commentary", "global", { text: "bye" }, "openrouter/qwen3");
    expect((await mod.getPrecomputed("digest_commentary", "global"))?.payload).toEqual({ text: "bye" });
  };

  it("round-trips against SQLite", () => run(loadWithSqlite));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run(loadWithNeon));
});
