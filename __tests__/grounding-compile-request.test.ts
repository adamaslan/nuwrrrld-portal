import { readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const compilerPath = fileURLToPath(new URL("../scripts/compile_grounding_pack.mjs", import.meta.url));
const source = readFileSync(compilerPath, "utf8");
const optionalModel = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
const policySource = `export const FREE_MODEL_CHAIN = ['${optionalModel}'];
const OPTIONAL_REASONING_MODELS = new Set<string>(['${optionalModel}']);`;

// Execute the actual CLI functions without starting main, loading credentials,
// reading a database or contacting a provider. The policy source and fetch are
// explicit fixtures. This tests request behavior, not live provider recovery.
function compiler(fetchImpl: typeof fetch, model = optionalModel) {
  const executable = source
    .replace(/^import .*;\r?\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(new URL("../scripts/compile_grounding_pack.mjs", import.meta.url).href));
  const mainCall = executable.lastIndexOf("\nmain().catch(");
  if (mainCall < 0) throw new Error("Compiler main boundary not found");
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const context = vm.createContext({
    URL, AbortController, Error, JSON, Map, Set,
    join, relative, extname, fileURLToPath,
    readFileSync: () => policySource,
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    console: logger,
    process: { argv: ["node", compilerPath], env: { COMPILE_MODEL: model } },
  });
  vm.runInContext(executable.slice(0, mainCall), context);
  return {
    extract: () => vm.runInContext('extractRules("test-placeholder", { chunkId: "fixture-chunk", sourceFile: "fixture.md", body: "An ordinary fixture excerpt." })', context) as Promise<unknown[]>,
    failures: () => vm.runInContext("extractFailures", context) as number,
    logger,
  };
}

const response = (content = "[]", finishReason = "stop") => new Response(JSON.stringify({
  choices: [{ message: { content }, finish_reason: finishReason }],
}), { status: 200 });

afterEach(() => vi.useRealTimers());

describe("grounding compiler extraction request", () => {
  it("bounds output and disables only known optional reasoning in the actual request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const c = compiler(fetchMock);
    await c.extract();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: optionalModel, temperature: 0, max_tokens: 2048, reasoning: { enabled: false } });
    expect(c.failures()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("completes an answer-only fixture that otherwise consumes the entire timeout reasoning", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).reasoning?.enabled === false) return Promise.resolve(response());
      return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    });
    const c = compiler(fetchMock);
    const result = c.extract();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual([]);
    expect(c.failures()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not force a reasoning-disable parameter on unknown or mandatory-reasoning models", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    const c = compiler(fetchMock, "fixture/mandatory-reasoning:free");
    await c.extract();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("reasoning");
    expect(body.model).toBe("fixture/mandatory-reasoning:free");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never marks a length-truncated response as successful, even when it contains a valid array", async () => {
    const c = compiler(vi.fn().mockResolvedValue(response("[]", "length")));
    expect(await c.extract()).toEqual([]);
    expect(c.failures()).toBe(1);
  });

  it("keeps genuine empty extraction successful", async () => {
    const c = compiler(vi.fn().mockResolvedValue(response()));
    expect(await c.extract()).toEqual([]);
    expect(c.failures()).toBe(0);
  });

  it("retains one bounded timeout attempt and a failed-extraction result without retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const c = compiler(fetchMock);
    const result = c.extract();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toEqual([]);
    expect(c.failures()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
