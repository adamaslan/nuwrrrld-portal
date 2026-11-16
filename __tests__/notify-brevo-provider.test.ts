import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrevoProvider, parseSender } from "@/lib/notify/brevo";
import { selectEmailProvider } from "@/lib/notify/select";

const MSG = { from: "NuWrrrld Financial <noreply@financial.nuwrrrld.com>", to: ["a@x.test"], subject: "S", html: "<p>h</p>" };
afterEach(() => vi.unstubAllGlobals());

describe("parseSender", () => {
  it("splits name and address, trims name to 70 chars, handles bare address", () => {
    expect(parseSender(MSG.from)).toEqual({ email: "noreply@financial.nuwrrrld.com", name: "NuWrrrld Financial" });
    expect(parseSender("x@y.test")).toEqual({ email: "x@y.test" });
    expect(parseSender(`${"n".repeat(80)} <x@y.test>`).name).toHaveLength(70);
  });
});

describe("createBrevoProvider", () => {
  it("posts the documented request shape and surfaces status", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate" });
    vi.stubGlobal("fetch", fetchMock);
    const r = await createBrevoProvider("bk").send(MSG, { timeoutMs: 10_000 });
    expect(r).toMatchObject({ ok: false, status: 429 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.headers["api-key"]).toBe("bk");
    expect(JSON.parse(init.body)).toEqual({
      sender: { email: "noreply@financial.nuwrrrld.com", name: "NuWrrrld Financial" },
      to: [{ email: "a@x.test" }], subject: "S", htmlContent: "<p>h</p>",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it("refuses an idempotency key and sends nothing", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(createBrevoProvider("bk").send(MSG, { idempotencyKey: "k" })).rejects.toThrow(/idempotency/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("selectEmailProvider", () => {
  it("defaults to resend, requires its key, never falls back", () => {
    expect(selectEmailProvider({ RESEND_API_KEY: "r" }).name).toBe("resend");
    expect(() => selectEmailProvider({})).toThrow(/RESEND_API_KEY/);
    expect(() => selectEmailProvider({ ALERT_EMAIL_PROVIDER: "brevo", RESEND_API_KEY: "r" })).toThrow(/BREVO_API_KEY/);
  });
  it("selects brevo only when asked and keyed; rejects unknown", () => {
    const p = selectEmailProvider({ ALERT_EMAIL_PROVIDER: "brevo", BREVO_API_KEY: "b" });
    expect(p.name).toBe("brevo"); expect(p.supportsIdempotencyKey).toBe(false);
    expect(() => selectEmailProvider({ ALERT_EMAIL_PROVIDER: "smtp" })).toThrow(/Unsupported/);
  });
});
