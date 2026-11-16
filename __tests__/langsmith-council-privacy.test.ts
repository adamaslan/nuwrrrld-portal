import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "langsmith";

type SanitizingClient = {
  prepareRunCreateOrUpdateInputs(run: Record<string, unknown>): Promise<Record<string, unknown>>;
};

// Exercise the real pinned SDK's traceable/run-tree and payload sanitizer,
// intercepting immediately before transport. No real endpoint is contacted.
describe("enabled Council tracing privacy with pinned SDK", () => {
  const sent: Record<string, unknown>[] = [];
  let fetchGuard: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    sent.length = 0;
    vi.stubEnv("NWF_LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGSMITH_API_KEY", "offline-synthetic-key");
    vi.stubEnv("LANGSMITH_API_URL", "http://127.0.0.1:1");
    fetchGuard = vi.fn(() => { throw new Error("Network forbidden in offline privacy test"); });
    vi.stubGlobal("fetch", fetchGuard);
    vi.spyOn(Client.prototype, "createRun").mockImplementation(async function (this: Client, run) {
      sent.push(await (this as unknown as SanitizingClient)
        .prepareRunCreateOrUpdateInputs(run as unknown as Record<string, unknown>));
    });
    vi.spyOn(Client.prototype, "updateRun").mockImplementation(async function (this: Client, _id, run) {
      sent.push(await (this as unknown as SanitizingClient)
        .prepareRunCreateOrUpdateInputs(run as unknown as Record<string, unknown>));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("redacts thrown error strings on child and parent while preserving caller error", async () => {
    const { traceCouncilAttempt, traceCouncilRun } = await import("../lib/langsmith-council-trace");
    const error = new Error("SYNTHETIC_PRIVATE_ERROR Authorization: Bearer synthetic-secret prompt=private");
    const operation = vi.fn(async () => { throw error; });
    await expect(traceCouncilRun("T1", () => traceCouncilAttempt(
      { seat: "T1", model: "synthetic-free-model", attempt: 1, primary: true, answerOnly: true },
      operation,
    ))).rejects.toBe(error);
    await vi.waitFor(() => expect(sent.filter((run) => typeof run.error === "string").length).toBeGreaterThanOrEqual(2));
    expect(sent.filter((run) => typeof run.error === "string").map((run) => run.name))
      .toEqual(expect.arrayContaining(["council.run_seat", "council.model_attempt"]));
    expect(operation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toContain("SYNTHETIC_PRIVATE_ERROR");
    expect(JSON.stringify(sent)).not.toContain("synthetic-secret");
    expect(sent.filter((run) => typeof run.error === "string").every((run) => run.error === "[redacted]"))
      .toBe(true);
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("drops successful content while preserving the original caller result", async () => {
    const { traceCouncilAttempt } = await import("../lib/langsmith-council-trace");
    const result = { status: 200, data: { choices: [{ message: { content: "SYNTHETIC_PRIVATE_CONTENT" },
      finish_reason: "stop" }], usage: { completion_tokens_details: { reasoning_tokens: 4 } } } };
    const operation = vi.fn(async () => result);
    await expect(traceCouncilAttempt(
      { seat: "T1", model: "synthetic-free-model", attempt: 1, primary: true, answerOnly: true },
      operation,
    )).resolves.toBe(result);
    await vi.waitFor(() => expect(sent.some((run) => "outputs" in run)).toBe(true));
    expect(operation).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toContain("SYNTHETIC_PRIVATE_CONTENT");
    expect(JSON.stringify(sent)).toContain('"has_content":true');
    expect(sent.every(run => run.error === undefined)).toBe(true);
    expect(fetchGuard).not.toHaveBeenCalled();
  });
});
