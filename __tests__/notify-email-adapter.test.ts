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
import { createResendProvider } from "@/lib/notify/email";
import { POST as digest } from "@/app/api/retention/digest-email/route";
import { POST as nudge } from "@/app/api/retention/trial-nudge/route";
import { POST as remind } from "@/app/api/launch/remind/route";

const FROM = "NuWrrrld Financial <noreply@financial.nuwrrrld.com>";
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

describe("createResendProvider", () => {
  it("sends the same request shape the routes used inline", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    const result = await createResendProvider("k").send({ from: FROM, to: ["a@x.test"], subject: "S", html: "<p>h</p>" });
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer k", "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ from: FROM, to: ["a@x.test"], subject: "S", html: "<p>h</p>" });
    expect(init.signal).toBeUndefined();
  });
  it("adds a timeout signal and idempotency header only when asked", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await createResendProvider("k").send({ from: FROM, to: ["a@x.test"], subject: "S", html: "h" }, { timeoutMs: 5000, idempotencyKey: "k1" });
    const init = fetchMock.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(5000);
    expect(init.headers["Idempotency-Key"]).toBe("k1");
  });
  it("does not swallow network errors and reads the error body lazily", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(createResendProvider("k").send({ from: FROM, to: ["a@x.test"], subject: "S", html: "h" })).rejects.toThrow("boom");
    const text = vi.fn().mockResolvedValue("quota");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text }));
    const r = await createResendProvider("k").send({ from: FROM, to: ["a@x.test"], subject: "S", html: "h" });
    expect(r.ok).toBe(false);
    expect(text).not.toHaveBeenCalled();
    expect(await r.errorText()).toBe("quota");
  });
});

describe("routes keep their pre-adapter behavior", () => {
  it("trial nudge: same subject/from/recipient, 10s bound, counter increments only on ok", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true }); vi.stubGlobal("fetch", fetchMock);
    const res = await nudge(req("/api/retention/trial-nudge", { userId: "u1" }));
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body);
    expect(body.from).toBe(FROM); expect(body.to).toEqual(["test@example.test"]);
    expect(body.subject).toBe("Your free trial ends in 48 hours");
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    expect(mocks.updateMetadata).toHaveBeenCalledTimes(1);
  });
  it("trial nudge: provider rejection returns 502 and does not increment", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "" }));
    const res = await nudge(req("/api/retention/trial-nudge", { userId: "u1" }));
    expect(res.status).toBe(502);
    expect(mocks.updateMetadata).not.toHaveBeenCalled();
  });
  it("digest: no abort signal (unchanged), 502 on provider failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const res = await digest(req("/api/retention/digest-email", { userId: "u1" }));
    expect(res.status).toBe(502);
    const emailCall = fetchMock.mock.calls.find(c => c[0] === "https://api.resend.com/emails")!;
    expect(emailCall[1].signal).toBeUndefined();
    expect(JSON.parse(emailCall[1].body).subject).toBe("Your weekly signal digest");
  });
  it("launch reminder: one send per recipient, failure counted and logged", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "daily_quota_exceeded" });
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await remind(req("/api/launch/remind", { to: ["a@x.test", "b@x.test"] }));
    expect(await res.json()).toEqual({ sent: 1, failed: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).to).toEqual(["b@x.test"]);
    expect(err).toHaveBeenCalledWith("resend error for", "b@x.test", "daily_quota_exceeded");
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 10_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 10_000);
    err.mockRestore(); log.mockRestore();
  });
});
