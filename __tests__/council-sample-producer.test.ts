import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  subjects: vi.fn(),
  runLog: vi.fn(),
  model: vi.fn(),
}));
vi.mock("@/lib/http-auth", () => ({ bearerTokenMatches: () => true }));
vi.mock("@/lib/openrouter", () => ({
  FREE_MODEL_CHAIN: [], fetchWithModelFallbackChecked: mocks.model,
}));
vi.mock("@/lib/pipeline-run-log-db", () => ({ logPipelineRun: mocks.runLog }));
vi.mock("@/lib/precomputed-ai-db", () => ({
  listWatchlistSubjects: mocks.subjects,
  savePrecomputed: vi.fn(),
  subjectFromTickers: vi.fn(),
}));
vi.mock("@/lib/ticker-cards-db", () => ({ topCards: vi.fn() }));
vi.mock("@/app/dashboard/holdfold/council-sample", () => ({ refreshCouncilSample: mocks.refresh }));
import { POST } from "@/app/api/pipeline/precompute-ai/route";

function request(body: object) {
  return new NextRequest("https://example.test/api/pipeline/precompute-ai", {
    method: "POST", body: JSON.stringify(body),
    headers: { authorization: "Bearer fixture" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PORTAL_PUSH_SECRET", "fixture");
  vi.stubEnv("OPENROUTER_API_KEY", "fixture");
  mocks.subjects.mockResolvedValue([]);
  mocks.runLog.mockResolvedValue(true);
  mocks.refresh.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("nightly council sample producer", () => {
  it("writes the sample even when there are no portfolio subjects", async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(200);
    expect((await response.json()).councilSampleSaved).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it("keeps a dry run read-only", async () => {
    const response = await POST(request({ dry_run: true }));
    expect(response.status).toBe(200);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps the sample producer independent of the model key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const response = await POST(request({}));
    expect(response.status).toBe(503);
    expect((await response.json()).councilSampleSaved).toBe(true);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
