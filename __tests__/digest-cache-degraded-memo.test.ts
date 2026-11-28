import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestPayload, SignalPayload } from "@/lib/digest";

// Drives the real lib/digest-cache.ts + lib/digest-cache-db.ts against an
// in-memory stand-in for the two digest tables, counting every query and the
// serialized bytes of every result set. The live backend is down throughout
// unless a test says otherwise, so requests land on the degraded path.

interface DigestRow { payload: DigestPayload; generated_at: string }
interface UserRow { payload: DigestPayload; expires_at: string }

const db = {
  global: [] as DigestRow[],
  users: new Map<string, UserRow>(),
  failing: false,
  log: [] as { kind: string; bytes: number }[],
};

function record<T>(kind: string, rows: T[]): T[] {
  db.log.push({ kind, bytes: Buffer.byteLength(JSON.stringify(rows)) });
  return rows;
}

function newestGlobal(): DigestRow[] {
  return [...db.global].sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at)).slice(0, 1);
}

vi.mock("@/lib/db", () => ({
  default: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (db.failing) {
      db.log.push({ kind: "error", bytes: 0 });
      throw new Error("HTTP 402 quota exceeded");
    }
    if (text.includes("FROM user_digest_cache")) {
      const row = db.users.get(values[0] as string);
      return record("user", row && Date.parse(row.expires_at) > Date.now() ? [row] : []);
    }
    if (text.includes("INSERT INTO user_digest_cache")) {
      db.users.set(values[0] as string, { payload: JSON.parse(values[1] as string), expires_at: values[2] as string });
      return record("user-write", []);
    }
    if (text.includes("FROM signal_digest_cache") && text.includes("generated_at >")) {
      const ttlMs = Number(values[0]) * 60_000;
      return record("global-fresh", newestGlobal().filter((r) => Date.now() - Date.parse(r.generated_at) < ttlMs));
    }
    if (text.includes("FROM signal_digest_cache")) {
      return record("global-any-age", newestGlobal());
    }
    if (text.includes("INSERT INTO signal_digest_cache")) {
      return record("global-write", []);
    }
    throw new Error(`unexpected query: ${text}`);
  },
}));

const START = Date.parse("2026-11-27T15:00:00Z");

/** Shape of a local refresh-signals.py push: one signal per beta1 ticker. */
function digest(label: string, generatedAt: string): DigestPayload {
  const tickers = ["MU", "GLD", "NVDA", "RGTI", "PL", "GEV", "GOOG", "IBIT", "APLD"];
  const signals: SignalPayload[] = tickers.map((ticker, i) => ({
    id: `${ticker}-20261126`,
    ticker,
    direction: i % 3 === 0 ? "bearish" : "bullish",
    timeframe: "short",
    confidence: i % 2 === 0 ? "high" : "medium",
    title: `${ticker} bullish signal (medium confidence)`,
    explanation:
      "RSI at 61.4 (neutral). MACD histogram positive at 0.412. Price 3.2% above 20-day SMA. Volume 1.4x the 20-day average.",
    indicators: ["RSI", "MACD", "SMA20", "Volume"],
    generatedAt,
    isStale: false,
  }));
  return { schemaVersion: 1, periodLabel: label, signals, generatedAt, sources: ["alpaca-local"] };
}

async function load() {
  return import("@/lib/digest-cache");
}

function payloadReads() {
  return db.log.filter((q) => q.kind === "global-any-age");
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubEnv("MCP_BACKEND_URL", "https://backend.invalid");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("backend down")));
  db.global = [{ payload: digest("Signals for 2026-11-26", "2026-11-26T21:05:00Z"), generated_at: "2026-11-26T21:05:00Z" }];
  db.users.clear();
  db.failing = false;
  db.log = [];
  vi.resetModules(); // cold serverless instance: every in-process cache empty
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getOrFetchDigest — degraded fallback is not re-read on every request", () => {
  it("reads the stale payload once across cold+warm requests from two users", async () => {
    const { getOrFetchDigest } = await load();

    const a1 = await getOrFetchDigest("user_a"); // cold
    const b1 = await getOrFetchDigest("user_b");
    vi.advanceTimersByTime(60_000);
    const a2 = await getOrFetchDigest("user_a"); // warm
    const b2 = await getOrFetchDigest("user_b");

    for (const result of [a1, b1, a2, b2]) {
      expect(result?.periodLabel).toBe("Signals for 2026-11-26");
      expect(result?.degraded).toBe(true);
    }
    expect(payloadReads()).toHaveLength(1);
    // The fresh-row check still runs on every request, so a new push is
    // picked up immediately; it returns no rows while the digest is stale.
    const freshChecks = db.log.filter((q) => q.kind === "global-fresh");
    expect(freshChecks).toHaveLength(4);
    expect(freshChecks.every((q) => q.bytes === 2)).toBe(true);
  });

  it("serves a newly pushed fresh row on the next request, not the memo", async () => {
    const { getOrFetchDigest } = await load();
    expect((await getOrFetchDigest("user_a"))?.degraded).toBe(true);

    vi.advanceTimersByTime(30_000);
    const pushedAt = new Date().toISOString();
    db.global.push({ payload: digest("Signals for 2026-11-27", pushedAt), generated_at: pushedAt });

    const next = await getOrFetchDigest("user_a");
    expect(next?.periodLabel).toBe("Signals for 2026-11-27");
    expect(next?.degraded).toBeUndefined();
  });

  it("re-reads after the memo window so a newer stale row is not hidden for long", async () => {
    const { getOrFetchDigest } = await load();
    await getOrFetchDigest(null);

    db.global.push({ payload: digest("Signals for 2026-11-27 midday", "2026-11-27T14:00:00Z"), generated_at: "2026-11-27T14:00:00Z" });
    vi.advanceTimersByTime(5 * 60_000 + 1);

    const next = await getOrFetchDigest(null);
    expect(next?.periodLabel).toBe("Signals for 2026-11-27 midday");
    expect(next?.degraded).toBe(true);
    expect(payloadReads()).toHaveLength(2);
  });

  it("never caches a failed read: a database outage is retried on the next request", async () => {
    const { getOrFetchDigest } = await load();
    db.failing = true;
    expect(await getOrFetchDigest("user_a")).toBeNull();

    db.failing = false;
    const next = await getOrFetchDigest("user_a");
    expect(next?.periodLabel).toBe("Signals for 2026-11-26");
    expect(payloadReads()).toHaveLength(1);
  });

  it("keeps per-user rows per user: one user's cached row is never served to another", async () => {
    db.users.set("user_a", {
      payload: digest("user_a row", "2026-11-27T14:55:00Z"),
      expires_at: new Date(START + 10 * 60_000).toISOString(),
    });
    const { getOrFetchDigest } = await load();

    expect((await getOrFetchDigest("user_a"))?.periodLabel).toBe("user_a row");
    const b = await getOrFetchDigest("user_b");
    expect(b?.periodLabel).toBe("Signals for 2026-11-26");
    expect(b?.degraded).toBe(true);
    expect((await getOrFetchDigest("user_a"))?.periodLabel).toBe("user_a row");
  });
});
