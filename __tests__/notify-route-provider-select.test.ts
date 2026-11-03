import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  // digest-email reads MCP_BACKEND_URL at module load, so set it before import.
  process.env.MCP_BACKEND_URL = "https://mcp.example.test";
  return { getUser: vi.fn(), updateMetadata: vi.fn() };
});
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({ users: { getUser: mocks.getUser, updateUserMetadata: mocks.updateMetadata } }),
}));
vi.mock("@/lib/http-auth", () => ({ bearerTokenMatches: () => true }));
import { POST as digest } from "@/app/api/retention/digest-email/route";
import { POST as remind } from "@/app/api/launch/remind/route";
import { POST as nudge } from "@/app/api/retention/trial-nudge/route";

const req = (path: string, body: object) =>
  new NextRequest(`https://example.test${path}`, { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("RESEND_API_KEY", "test-key");
  mocks.getUser.mockResolvedValue({
    firstName: "Test",
    emailAddresses: [{ emailAddress: "test@example.test", verification: { status: "verified" } }],
    privateMetadata: {},
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("routes provider selection (ALERT_EMAIL_PROVIDER)", () => {
  it("unset: still sends through Resend", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetchMock);
    const res = await nudge(req("/api/retention/trial-nudge", { userId: "u1" }));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.resend.com/emails");
  });
  it("unset and no Resend key: same 503 message as before", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const res = await nudge(req("/api/retention/trial-nudge", { userId: "u1" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("RESEND_API_KEY not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("brevo opted in: sends to Brevo only, never calls Resend", async () => {
    vi.stubEnv("ALERT_EMAIL_PROVIDER", "brevo"); vi.stubEnv("BREVO_API_KEY", "b-key");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetchMock);
    const res = await nudge(req("/api/retention/trial-nudge", { userId: "u1" }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.brevo.com/v3/smtp/email");
  });
  it("brevo opted in but failing: 502, no second send on Resend", async () => {
    vi.stubEnv("ALERT_EMAIL_PROVIDER", "brevo"); vi.stubEnv("BREVO_API_KEY", "b-key");
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "" }); vi.stubGlobal("fetch", fetchMock);
    const res = await nudge(req("/api/retention/trial-nudge", { userId: "u1" }));
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });
  it("brevo opted in without key: 503, nothing sent", async () => {
    vi.stubEnv("ALERT_EMAIL_PROVIDER", "brevo"); vi.stubEnv("BREVO_API_KEY", "");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const res = await digest(req("/api/retention/digest-email", {}));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("launch reminder: unset sends to Resend, brevo opt-in sends only to Brevo and logs its name", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetchMock);
    await remind(req("/api/launch/remind", { to: ["a@x.test"] }));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    vi.stubEnv("ALERT_EMAIL_PROVIDER", "brevo"); vi.stubEnv("BREVO_API_KEY", "b-key");
    fetchMock.mockClear().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
    const res = await remind(req("/api/launch/remind", { to: ["a@x.test"] }));
    expect(await res.json()).toEqual({ sent: 0, failed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.brevo.com/v3/smtp/email");
    expect(err).toHaveBeenCalledWith("brevo error for", "a@x.test", "boom");
    log.mockRestore(); err.mockRestore();
  });
});
