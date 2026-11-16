import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";

export type CouncilTraceContext = {
  seat: string;
  model: string;
  attempt: number;
  primary: boolean;
  answerOnly: boolean;
};

type AttemptResult = {
  status: number;
  data?: unknown;
};

let cachedClient: Client | null | undefined;

function langSmithClient(): Client | null {
  if (cachedClient !== undefined) return cachedClient;

  const apiKey = process.env.LANGSMITH_API_KEY?.trim();
  const apiUrl = process.env.LANGSMITH_API_URL?.trim();
  if (
    process.env.NWF_LANGSMITH_TRACING !== "true" ||
    !apiKey ||
    !apiUrl
  ) {
    cachedClient = null;
    return null;
  }

  try {
    cachedClient = new Client({
      apiKey,
      apiUrl,
      // Payload allowlists below are defense in depth. Never persist prompts,
      // completions, caller IDs, or raw provider errors.
      hideInputs: () => ({}),
      hideOutputs: summarizeAttempt,
      hideMetadata: safeMetadata,
      anonymizer: () => ({}),
      omitTracedRuntimeInfo: true,
      blockOnRootRunFinalization: false,
    });
  } catch {
    cachedClient = null;
  }
  return cachedClient;
}

function safeMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const values = metadata ?? {};
  return {
    ...(typeof values.seat === "string" ? { seat: values.seat } : {}),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(Number.isInteger(values.attempt) ? { attempt: values.attempt } : {}),
    ...(typeof values.primary === "boolean" ? { primary: values.primary } : {}),
    ...(typeof values.answerOnly === "boolean" ? { answer_only: values.answerOnly } : {}),
  };
}

function summarizeAttempt(value: Record<string, unknown>): Record<string, unknown> {
  const wrapped = value.outputs;
  const result =
    wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : value;
  const data = result.data;
  const body = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
  const choiceValue = body?.choices;
  const choice = Array.isArray(choiceValue) && choiceValue[0] && typeof choiceValue[0] === "object"
    ? (choiceValue[0] as Record<string, unknown>)
    : undefined;
  const messageValue = choice?.message;
  const message = messageValue && typeof messageValue === "object"
    ? (messageValue as Record<string, unknown>)
    : undefined;
  const content = typeof message?.content === "string" ? message.content : "";
  const usageValue = body?.usage;
  const usage = usageValue && typeof usageValue === "object"
    ? (usageValue as Record<string, unknown>)
    : undefined;
  const completionDetailsValue = usage?.completion_tokens_details;
  const completionDetails = completionDetailsValue && typeof completionDetailsValue === "object"
    ? (completionDetailsValue as Record<string, unknown>)
    : undefined;
  const reasoningTokens = completionDetails?.reasoning_tokens;
  const finishReason = choice?.finish_reason;
  const safeStatus = result.http_status ?? result.status;
  const safeFinishReason = result.finish_reason ?? finishReason;
  const safeReasoningTokens = result.reasoning_tokens ?? reasoningTokens;
  const safeContentLength = result.content_length ?? content.length;
  const safeHasContent = result.has_content ?? (content.trim().length > 0);

  return {
    ...(typeof safeStatus === "number"
      ? { http_status: safeStatus }
      : {}),
    ...(typeof safeFinishReason === "string" ? { finish_reason: safeFinishReason.slice(0, 32) } : {}),
    ...(typeof safeReasoningTokens === "number" && Number.isFinite(safeReasoningTokens)
      ? { reasoning_tokens: safeReasoningTokens }
      : {}),
    ...(typeof safeContentLength === "number" && Number.isFinite(safeContentLength)
      ? { content_length: safeContentLength }
      : {}),
    ...(typeof safeHasContent === "boolean" ? { has_content: safeHasContent } : {}),
  };
}

/**
 * Run one model attempt with opt-in, content-free LangSmith tracing.
 * If tracing is unset or unavailable, the model operation still runs once.
 */
export async function traceCouncilAttempt<T extends AttemptResult>(
  context: CouncilTraceContext,
  operation: () => Promise<T>,
): Promise<T> {
  const client = langSmithClient();
  if (!client) return operation();

  const state: { complete: boolean; failed: boolean; result?: T; error?: unknown } = {
    complete: false,
    failed: false,
  };
  const traced = traceable(
    async () => {
      try {
        state.result = await operation();
        state.complete = true;
        return state.result;
      } catch (error) {
        state.failed = true;
        state.error = error;
        throw error;
      }
    },
    {
      name: "council.model_attempt",
      run_type: "llm",
      project_name: "nuwrrrld-council-attempts",
      client,
      tracingEnabled: true,
      tags: ["council", "model-attempt"],
      metadata: context,
      processInputs: () => ({}),
      processOutputs: summarizeAttempt,
    },
  );

  try {
    await traced();
  } catch {
    // LangSmith is an observer. A trace SDK failure before the provider call
    // must not fail the user's Council request or cause a duplicate call.
    if (state.failed) throw state.error;
    if (state.complete) return state.result as T;
    return operation();
  }

  return state.result as T;
}

/** Create a content-free parent run so provider attempts appear as child runs. */
export async function traceCouncilRun<T>(
  seat: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = langSmithClient();
  if (!client) return operation();

  const state: { complete: boolean; failed: boolean; result?: T; error?: unknown } = {
    complete: false,
    failed: false,
  };
  const traced = traceable(
    async () => {
      try {
        state.result = await operation();
        state.complete = true;
        return state.result;
      } catch (error) {
        state.failed = true;
        state.error = error;
        throw error;
      }
    },
    {
      name: "council.run_seat",
      run_type: "chain",
      project_name: "nuwrrrld-council-attempts",
      client,
      tracingEnabled: true,
      tags: ["council", "seat-run"],
      metadata: { seat },
      processInputs: () => ({}),
      processOutputs: () => ({}),
    },
  );

  try {
    await traced();
  } catch {
    if (state.failed) throw state.error;
    if (state.complete) return state.result as T;
    return operation();
  }

  return state.result as T;
}
