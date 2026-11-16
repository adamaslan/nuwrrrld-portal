import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "langsmith";

type Sanitizer = { prepareRunCreateOrUpdateInputs(run: Record<string, unknown>): Promise<Record<string, unknown>> };

describe("actual Council fallback with enabled tracing and intercepted transport", () => {
  const sent: Record<string, unknown>[] = [];
  beforeEach(() => {
    vi.resetModules(); sent.length = 0;
    vi.stubEnv("NWF_LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGSMITH_API_KEY", "synthetic-trace-key");
    vi.stubEnv("LANGSMITH_API_URL", "http://127.0.0.1:1");
    vi.spyOn(Client.prototype, "createRun").mockImplementation(async function (this: Client, run) {
      sent.push(await (this as unknown as Sanitizer).prepareRunCreateOrUpdateInputs(run as unknown as Record<string, unknown>));
    });
    vi.spyOn(Client.prototype, "updateRun").mockImplementation(async function (this: Client, _id, run) {
      sent.push(await (this as unknown as Sanitizer).prepareRunCreateOrUpdateInputs(run as unknown as Record<string, unknown>));
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  function provider(plan: Array<{ status: number; content?: string; finish?: string }>) {
    let index = 0;
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (!String(url).endsWith("/chat/completions")) throw new Error("Unexpected network destination");
      const item = plan[Math.min(index++, plan.length - 1)];
      return new Response(JSON.stringify(item.status === 200
        ? { choices: [{ message: { content: item.content ?? "" }, finish_reason: item.finish ?? "stop" }] }
        : { error: "SYNTHETIC_PROVIDER_BODY" }), { status: item.status });
    });
    vi.stubGlobal("fetch", fetch); return fetch;
  }
  async function assertPrivateFieldsAbsent() {
    await vi.waitFor(() => expect(sent.some(r => "outputs" in r || "error" in r)).toBe(true));
    const payload = JSON.stringify(sent);
    for (const sentinel of ["SYNTHETIC_PRIVATE_PROMPT", "SYNTHETIC_PRIVATE_ANSWER", "synthetic-provider-key", "SYNTHETIC_PRIVATE_ERROR", "SYNTHETIC_PROVIDER_BODY", "SYNTHETIC_FINISH_PRIVATE"])
      expect(payload).not.toContain(sentinel);
    expect(sent.filter(r => r.error !== undefined).every(r => r.error === "[redacted]")).toBe(true);
  }
  const messages = [{ role: "user" as const, content: "SYNTHETIC_PRIVATE_PROMPT" }];

  it("advances past an empty completion and returns the answer, exactly once per attempt", async () => {
    const fetch = provider([{ status: 200 }, { status: 200, content: "SYNTHETIC_PRIVATE_ANSWER", finish: "SYNTHETIC_FINISH_PRIVATE" }]);
    const { runSeat } = await import("../lib/openrouter");
    const result = await runSeat("T1", messages, "synthetic-provider-key", 1200, 0.4, "synthetic-primary");
    expect(result.answer).toBe("SYNTHETIC_PRIVATE_ANSWER"); expect(fetch).toHaveBeenCalledTimes(2);
    await assertPrivateFieldsAbsent();
    expect(JSON.stringify(sent)).toContain('"has_content":true');
  });
  it("falls through a retired primary without duplicating the successful attempt", async () => {
    const fetch = provider([{ status: 404 }, { status: 200, content: "SYNTHETIC_PRIVATE_ANSWER" }]);
    const { runSeat } = await import("../lib/openrouter");
    expect((await runSeat("T1", messages, "synthetic-provider-key", 1200, 0.4, "synthetic-primary")).answer).toBe("SYNTHETIC_PRIVATE_ANSWER");
    expect(fetch).toHaveBeenCalledTimes(2); await assertPrivateFieldsAbsent();
  });
  it("keeps the unavailable-chain contract and does not leak error bodies", async () => {
    const fetch = provider([{ status: 503 }]); const { runSeat, FREE_MODEL_CHAIN } = await import("../lib/openrouter");
    await expect(runSeat("T1", messages, "synthetic-provider-key", 1200, 0.4, "synthetic-primary"))
      .rejects.toMatchObject({ code: "council_provider_unavailable" });
    expect(fetch).toHaveBeenCalledTimes(FREE_MODEL_CHAIN.length + 1); await assertPrivateFieldsAbsent();
  });
  it("preserves a thrown provider error while redacting parent and child serialization", async () => {
    const error = new Error("SYNTHETIC_PRIVATE_ERROR"); const fetch = vi.fn(async () => { throw error; }); vi.stubGlobal("fetch", fetch);
    const { runSeat } = await import("../lib/openrouter");
    await expect(runSeat("T1", messages, "synthetic-provider-key")).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(1); await assertPrivateFieldsAbsent();
    await vi.waitFor(() => expect(sent.filter(r => r.error === "[redacted]").length).toBeGreaterThanOrEqual(2));
  });
  it("an SDK setup/observer failure does not repeat the provider call", async () => {
    vi.spyOn(Client.prototype, "createRun").mockImplementation(() => { throw new Error("synthetic observer unavailable"); });
    const fetch = provider([{ status: 200, content: "SYNTHETIC_PRIVATE_ANSWER" }]); const { runSeat } = await import("../lib/openrouter");
    expect((await runSeat("T1", messages, "synthetic-provider-key")).answer).toBe("SYNTHETIC_PRIVATE_ANSWER");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
