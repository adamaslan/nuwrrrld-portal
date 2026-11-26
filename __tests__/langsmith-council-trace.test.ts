import { beforeEach, describe, expect, it, vi } from "vitest";

const { traceOptions } = vi.hoisted(() => ({
  traceOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock("langsmith", () => ({
  Client: class {
    constructor(_options: Record<string, unknown>) {}
  },
}));

vi.mock("langsmith/traceable", () => ({
  traceable: (operation: () => Promise<unknown>, options: Record<string, unknown>) => {
    traceOptions.push(options);
    return operation;
  },
}));

describe("Council LangSmith tracing", () => {
  beforeEach(() => {
    traceOptions.length = 0;
    process.env.NWF_LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "test-key-not-real";
    process.env.LANGSMITH_API_URL = "https://langsmith.example.invalid";
  });

  it("records only allowlisted metadata and content-free attempt summaries", async () => {
    vi.resetModules();
    const { traceCouncilAttempt } = await import("@/lib/langsmith-council-trace");
    const operation = vi.fn(async () => ({
      status: 200,
      data: {
        choices: [{ message: { content: "private completion" }, finish_reason: "stop" }],
        usage: { completion_tokens_details: { reasoning_tokens: 7 } },
        private_provider_field: "must not be recorded",
      },
    }));

    const result = await traceCouncilAttempt(
      {
        seat: "bear",
        model: "synthetic/model",
        attempt: 2,
        primary: false,
        answerOnly: true,
        caller_id: "private-caller",
      } as never,
      operation,
    );

    expect(result).toMatchObject({ status: 200 });
    expect(operation).toHaveBeenCalledTimes(1);
    const options = traceOptions[0];
    expect(options.processInputs).toEqual(expect.any(Function));
    expect((options.processInputs as () => unknown)()).toEqual({});
    expect((options.processOutputs as (value: unknown) => unknown)({ outputs: result })).toEqual({
      http_status: 200,
      finish_reason: "stop",
      reasoning_tokens: 7,
      content_length: "private completion".length,
      has_content: true,
    });
    expect(options.metadata).not.toHaveProperty("caller_id");
  });
});
