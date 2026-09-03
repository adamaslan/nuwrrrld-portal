import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignalsClient } from "./SignalsClient";
import type { SignalPayload } from "@/lib/digest";

vi.mock("@/lib/shared/prefs", () => ({
  getPref: vi.fn(async () => null),
  setPref: vi.fn(async () => {}),
}));

// The signal card renders these children; they make their own network calls,
// which would otherwise pollute the fetch mock this suite asserts against.
vi.mock("@/components/TrackRecordBadge", () => ({ TrackRecordBadge: () => null }));
vi.mock("@/components/SignalAskAnything", () => ({ SignalAskAnything: () => null }));
vi.mock("@/components/SignalShareButton", () => ({ SignalShareButton: () => null }));

function makeSignal(overrides: Partial<SignalPayload> = {}): SignalPayload {
  return {
    id: "sig-1",
    ticker: "AAPL",
    direction: "bullish",
    timeframe: "short",
    confidence: "high",
    title: "RSI reclaim",
    explanation: "Momentum turned up.",
    indicators: ["RSI", "MACD"],
    generatedAt: "2026-08-30T12:00:00Z",
    isStale: false,
    ...overrides,
  };
}

const VERDICT = {
  outlook: "bullish",
  because: '[r1] says "RSI reclaimed 50"',
  invalidation: "close below 185",
  execution: "entry 190 / stop 185 / target 205",
};

async function expandAndAskDeeper() {
  const user = userEvent.setup();
  render(<SignalsClient signals={[makeSignal()]} />);
  await user.click(screen.getByRole("button", { name: "Details ↓" }));
  await user.click(screen.getByRole("button", { name: /Go deeper/ }));
  return user;
}

// This component mounts the full card tree under userEvent; 5s is not enough
// in CI. Applied per-suite so a slow environment can't produce a false failure.
describe("SignalsClient — Go Deeper (T1 council)", { timeout: 30000 }, () => {
  beforeEach(() => {
    // stubGlobal (not direct assignment) so unstubAllGlobals restores the
    // real fetch — vi.restoreAllMocks only tracks vi.spyOn, not `global.x =`.
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the four structured verdict fields the route actually returns", async () => {
    // Regression: the route responds { verdict, model, seat }. Reading a
    // non-existent `answer` key made every success render as an error.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ verdict: VERDICT, model: "openai/gpt-4o-mini", seat: "T1" }),
    });

    await expandAndAskDeeper();

    expect(await screen.findByText("close below 185")).toBeInTheDocument();
    expect(screen.getByText("entry 190 / stop 185 / target 205")).toBeInTheDocument();
    expect(screen.getByText('[r1] says "RSI reclaimed 50"')).toBeInTheDocument();
    expect(screen.queryByText(/empty response/)).not.toBeInTheDocument();
  });

  it("asks the T1 seat and passes the ticker so the verdict is attributable", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ verdict: VERDICT, model: "m", seat: "T1" }),
    });

    await expandAndAskDeeper();

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/council",
      expect.objectContaining({ body: expect.stringContaining('"seat":"T1"') }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/council",
      expect.objectContaining({ body: expect.stringContaining('"ticker":"AAPL"') }),
    );
  });

  it("maps council_response_invalid to its sentence, not a bare HTTP status", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ error: "council_response_invalid" }),
    });

    await expandAndAskDeeper();

    expect(await screen.findByText(/didn't come back in a usable format/)).toBeInTheDocument();
    expect(screen.queryByText(/502/)).not.toBeInTheDocument();
  });

  it("maps upgrade_required to the paywall message", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "upgrade_required" }),
    });

    await expandAndAskDeeper();

    expect(await screen.findByText(/Upgrade to Pro/)).toBeInTheDocument();
  });

  it("treats a 200 without a verdict as an error rather than rendering blank", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ model: "m", seat: "T1" }),
    });

    await expandAndAskDeeper();

    expect(await screen.findByText(/empty response/)).toBeInTheDocument();
  });

  it("offers a retry after a failure", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: "Council unavailable" }),
    });

    await expandAndAskDeeper();

    expect(await screen.findByRole("button", { name: "↺ Retry" })).toBeInTheDocument();
  });
});
