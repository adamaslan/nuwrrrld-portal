import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(), auth: vi.fn(), chat: vi.fn(), getUser: vi.fn(), updateMetadata: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ default: mocks.sql }));
vi.mock("@/lib/stripe", () => ({ PRICES: { monthly: "price_test_monthly", annual: "price_test_annual" } }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  clerkClient: async () => ({ users: { getUser: mocks.getUser, updateUserMetadata: mocks.updateMetadata } }),
}));
vi.mock("@/lib/signal-chat-local", () => ({ localSignalChat: mocks.chat }));
vi.mock("@/lib/http-auth", () => ({ bearerTokenMatches: () => true }));
import { GET } from "@/app/api/health/route";
import { POST as chat } from "@/app/api/signals/[ticker]/chat/route";
import { POST as nudge } from "@/app/api/retention/trial-nudge/route";
import { POST as remind } from "@/app/api/launch/remind/route";

function request(path: string, body: object) {
  return new NextRequest(`https://example.test${path}`, { method: "POST", body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "test-key");
  vi.stubEnv("MCP_BACKEND_URL", "https://mcp.example.test");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test_fixture");
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_live_fixture");
  vi.stubEnv("RESEND_API_KEY", "test-key");
  mocks.sql.mockResolvedValue([]);
  mocks.auth.mockResolvedValue({ userId: "fixture-user" });
  mocks.getUser.mockResolvedValue({ firstName: "Test", emailAddresses: [{ emailAddress: "test@example.test", verification: { status: "verified" } }], privateMetadata: {} });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("U9 route latency regressions", () => {
  it("marks a timed-out dependency degraded and caches health for 60 seconds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("slow", "AbortError")));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=60");
    expect((await response.json()).mcp.status).toBe("degraded");
  });
  it("keeps real database failures unhealthy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    mocks.sql.mockRejectedValue(new Error("database unavailable"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect((await response.json()).neon.status).toBe("down");
  });
  it("keeps the missing webhook-secret configuration check", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_placeholder_set_after_creating_endpoint");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    expect((await (await GET()).json()).stripe.status).toBe("not_configured");
  });
  it("answers chat directly without an unsupported upstream request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    mocks.chat.mockResolvedValue({ ticker: "AAPL", answer: "Grounded answer", tool_calls: [], fallback_used: false, created_at: "fixture" });
    const response = await chat(request("/api/signals/aapl/chat", { question: " What changed? " }), { params: Promise.resolve({ ticker: "aapl" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Signal-Chat-Source")).toBe("local");
    expect(mocks.chat).toHaveBeenCalledWith("AAPL", "What changed?");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["trial nudge", nudge, { userId: "fixture-user" }],
    ["launch reminder", remind, { to: ["test@example.test"] }],
  ] as const)("bounds %s delivery to ten seconds", async (_name, handler, body) => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetch);
    const response = await handler(request("/api/email", body));
    expect(response.status).toBe(200);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    timeout.mockRestore();
  });
  it("does not increment trial nudges after email timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("slow", "TimeoutError")));
    const response = await nudge(request("/api/email", { userId: "fixture-user" }));
    expect(response.status).toBe(502);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });
});
