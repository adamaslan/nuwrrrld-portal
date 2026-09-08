import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ──────────────────────────────────────────────────────────────────
const authMock = vi.fn();
const currentUserMock = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  currentUser: () => currentUserMock(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000", "x-forwarded-proto": "http" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { triggerPipelineRun, confirmLivePipelineRun } from "@/lib/nulogdash-actions";
import { __resetConfirmTokens } from "@/lib/nulogdash-trigger";
import { __resetRateLimitState } from "@/lib/rate-limit";
import { __resetDbGuardWarnLatch } from "@/lib/pipeline-db-guard";

const ADMIN_EMAIL = "admin@example.com";
const OLD_ENV = { ...process.env };

function asAdmin({ mfa = true }: { mfa?: boolean } = {}) {
  authMock.mockResolvedValue({ userId: "user_1" });
  currentUserMock.mockResolvedValue({
    primaryEmailAddressId: "idn_1",
    twoFactorEnabled: mfa,
    emailAddresses: [
      { id: "idn_1", emailAddress: ADMIN_EMAIL, verification: { status: "verified" } },
    ],
  });
}

function mockFetchOnce(status = 200, body = "{}") {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  __resetConfirmTokens();
  __resetRateLimitState();
  __resetDbGuardWarnLatch();
  process.env.NULOGDASH_ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.CRON_SECRET = "cron-secret";
  process.env.PORTAL_PUSH_SECRET = "portal-secret";
  delete process.env.PRODUCTION_DB_HOST;
  process.env.DATABASE_URL = "postgresql://ep-dev.neon.tech/db";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
});

describe("triggerPipelineRun (dry run)", () => {
  it("rejects a non-authenticated caller", async () => {
    authMock.mockResolvedValue({ userId: null });
    await expect(triggerPipelineRun({ pipeline: "followed-tickers" })).rejects.toThrow();
  });

  it("rejects an allowlisted admin without MFA", async () => {
    asAdmin({ mfa: false });
    await expect(triggerPipelineRun({ pipeline: "followed-tickers" })).rejects.toThrow(/two-factor/i);
  });

  it("rejects an unknown pipeline", async () => {
    asAdmin();
    const r = await triggerPipelineRun({ pipeline: "not-a-pipeline" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown pipeline/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fires a dry run with the right route + secret + body, and returns a confirm token", async () => {
    asAdmin();
    mockFetchOnce(200, JSON.stringify({ ok: true }));
    const r = await triggerPipelineRun({ pipeline: "precompute-ai" });

    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.confirmToken).toBeTruthy();

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/pipeline/precompute-ai");
    expect(init.headers.authorization).toBe("Bearer portal-secret");
    expect(JSON.parse(init.body)).toMatchObject({ dry_run: true, session: `nulogdash:${ADMIN_EMAIL}` });
  });

  it("surfaces a non-2xx from the pipeline route as an error", async () => {
    asAdmin();
    mockFetchOnce(503, "no");
    const r = await triggerPipelineRun({ pipeline: "followed-tickers" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });
});

describe("confirmLivePipelineRun (live run)", () => {
  async function freshToken(pipeline = "followed-tickers") {
    asAdmin();
    mockFetchOnce(200);
    const r = await triggerPipelineRun({ pipeline });
    return r.confirmToken as string;
  }

  it("rejects without a valid confirm token", async () => {
    asAdmin();
    const r = await confirmLivePipelineRun({
      pipeline: "followed-tickers",
      confirmToken: "bogus",
      typedName: "followed-tickers",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired or invalid/i);
  });

  it("rejects when the typed name does not match", async () => {
    const token = await freshToken();
    const r = await confirmLivePipelineRun({
      pipeline: "followed-tickers",
      confirmToken: token,
      typedName: "wrong",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not match/i);
  });

  it("refuses when DATABASE_URL resolves to PRODUCTION_DB_HOST", async () => {
    const token = await freshToken();
    process.env.PRODUCTION_DB_HOST = "ep-dev.neon.tech";
    const r = await confirmLivePipelineRun({
      pipeline: "followed-tickers",
      confirmToken: token,
      typedName: "followed-tickers",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/production/i);
  });

  it("runs live once, then rate-limits the immediate retry", async () => {
    const token1 = await freshToken();
    mockFetchOnce(200, JSON.stringify({ ok: true }));
    const first = await confirmLivePipelineRun({
      pipeline: "followed-tickers",
      confirmToken: token1,
      typedName: "followed-tickers",
    });
    expect(first.ok).toBe(true);
    expect(first.dryRun).toBe(false);
    const liveCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(JSON.parse(liveCall[1].body)).toMatchObject({ dry_run: false });

    const token2 = await freshToken();
    const second = await confirmLivePipelineRun({
      pipeline: "followed-tickers",
      confirmToken: token2,
      typedName: "followed-tickers",
    });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/rate limit/i);
  });

  it("burns the token — a second confirm with the same token fails", async () => {
    const token = await freshToken();
    mockFetchOnce(200);
    await confirmLivePipelineRun({
      pipeline: "followed-tickers",
      confirmToken: token,
      typedName: "followed-tickers",
    });
    const replay = await confirmLivePipelineRun({
      pipeline: "followed-tickers",
      confirmToken: token,
      typedName: "followed-tickers",
    });
    expect(replay.ok).toBe(false);
    expect(replay.error).toMatch(/expired or invalid/i);
  });
});
