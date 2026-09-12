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
import type { PaperAccount } from "@/lib/shared/paper-policy";

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
  "paper_accounts",
  "paper_runs",
  "paper_watchlists",
  "paper_positions",
  "paper_orders",
  "paper_nav",
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

/**
 * docs/council-paper-portfolios.md §5. Unlike the other blocks in this file,
 * this one seeds its own fixture rows (a ticker_universe row and one
 * paper_accounts row) directly through the mocked/real sql handle, since
 * lib/paper-db.ts deliberately has no account- or universe-creation
 * functions of its own — seeding is scripts/seed-paper-portfolios.mjs's job
 * (Phase 2), not this module's.
 *
 * The watchlist-guard trigger (paper_orders_watchlist_guard_trg) is
 * Postgres-only — dropped for SQLite by gen-sqlite-schema.mjs — so the
 * "rejects a buy off-watchlist" assertion runs only against Neon.
 */
describe("paper-db", () => {
  const TICKER = "PAPTEST";
  const ACCOUNT: PaperAccount = "quant";

  const run = async (mode: "sqlite" | "neon") => {
    vi.resetModules();
    // Matches either the SQLite-tag stand-in or the real Neon tag; both
    // support the two call shapes lib/paper-db.ts uses (`` sql`...` `` and
    // `sql.query`).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let seedSql: any;
    if (mode === "sqlite") {
      const db = new DatabaseSync(":memory:");
      loadSchema(db);
      seedSql = createSqliteSql(db);
    } else {
      const { neon } = await import("@neondatabase/serverless");
      seedSql = neon(process.env.DATABASE_URL!);
    }
    vi.doMock("@/lib/db", () => ({ default: seedSql }));
    const mod = await import("@/lib/paper-db");

    await seedSql`
      INSERT INTO ticker_universe (ticker, universe, name, active)
      VALUES (${TICKER}, 'stock', 'Paper Test Co', true)
      ON CONFLICT (ticker) DO NOTHING
    `;
    await seedSql`
      INSERT INTO paper_accounts (account, seat, label, policy_version, starting_cash, cash, seeded_on)
      VALUES (${ACCOUNT}, 'QUANT', 'Quant', 'v1', 10000, 10000, '2026-01-01')
      ON CONFLICT (account) DO NOTHING
    `;

    expect(await mod.getAccount(ACCOUNT)).toMatchObject({ account: ACCOUNT, cash: 10000 });
    expect(await mod.listAccounts()).toHaveLength(1);

    expect(await mod.isOnActiveWatchlist(ACCOUNT, TICKER)).toBe(false);
    await seedSql`
      INSERT INTO paper_watchlists (account, ticker, watchlist_version, in_seed_book, active)
      VALUES (${ACCOUNT}, ${TICKER}, 1, true, true)
      ON CONFLICT (account, ticker, watchlist_version) DO NOTHING
    `;
    expect(await mod.isOnActiveWatchlist(ACCOUNT, TICKER)).toBe(true);
    expect(await mod.listActiveWatchlist(ACCOUNT)).toHaveLength(1);

    const runId = await mod.insertRun({
      account: ACCOUNT,
      tradeDate: "2026-01-05",
      slot: "preopen",
      status: "ok",
      policyVersion: "v1",
    });
    expect(runId).toBeTruthy();
    // Idempotent on (account, trade_date, slot) — §4.4: a duplicate insert for
    // an already-run slot is absorbed (ON CONFLICT DO NOTHING), not a second row.
    const dupe = await mod.insertRun({
      account: ACCOUNT,
      tradeDate: "2026-01-05",
      slot: "preopen",
      status: "ok",
      policyVersion: "v1",
    });
    expect(dupe).toBeNull();
    expect(await mod.getRun(ACCOUNT, "2026-01-05", "preopen")).toMatchObject({ id: runId });

    await mod.updateRunDetail(runId!, { orders: 3 });
    expect((await mod.getRun(ACCOUNT, "2026-01-05", "preopen"))?.detail).toMatchObject({ orders: 3 });

    if (mode === "neon") {
      // paper_orders_watchlist_guard_trg — a buy off the active watchlist is a
      // bug, not a decision (§2.1), and is rejected at the DB level.
      await expect(
        mod.insertOrder({
          runId: runId!,
          account: ACCOUNT,
          ticker: "NOTLISTED",
          side: "buy",
          quantity: 1,
          refPrice: 100,
          fillPrice: 100.05,
          slippageBps: 5,
          notional: 100.05,
          realizedPnl: null,
          reason: "score_entry",
          decidedBy: "rule",
          model: null,
          cardScore: 80,
        }),
      ).rejects.toThrow();
    }

    const orderId = await mod.insertOrder({
      runId: runId!,
      account: ACCOUNT,
      ticker: TICKER,
      side: "buy",
      quantity: 2,
      refPrice: 100,
      fillPrice: 100.05,
      slippageBps: 5,
      notional: 200.1,
      realizedPnl: null,
      reason: "score_entry",
      decidedBy: "rule",
      model: null,
      cardScore: 80,
    });
    expect(orderId).toBeTruthy();
    expect(await mod.listOrders(ACCOUNT)).toHaveLength(1);

    await mod.upsertPosition({
      account: ACCOUNT,
      ticker: TICKER,
      quantity: 2,
      avgCost: 100.05,
      openedAt: "2026-01-05T14:30:00.000Z",
      lastTradeAt: "2026-01-05T14:30:00.000Z",
      runsHeld: 1,
      highWater: 100.05,
      thesis: null,
      invalidation: null,
    });
    expect(await mod.getPositions(ACCOUNT)).toHaveLength(1);

    await mod.insertNav({
      account: ACCOUNT,
      tradeDate: "2026-01-05",
      slot: "preopen",
      cash: 9799.9,
      positionsMv: 200.1,
      nav: 10000,
      dayReturn: 0,
      totalReturn: 0,
      positionsN: 1,
      turnover: 0.02,
    });
    expect(await mod.getNavSeries(ACCOUNT)).toHaveLength(1);

    await mod.deletePosition(ACCOUNT, TICKER);
    expect(await mod.getPositions(ACCOUNT)).toHaveLength(0);
  };

  it("round-trips against SQLite", () => run("sqlite"));
  it.skipIf(!hasNeon)("round-trips against Neon", () => run("neon"));
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
