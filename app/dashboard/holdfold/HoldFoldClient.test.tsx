import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HoldFoldClient } from "./HoldFoldClient";
import type { HoldFoldPayload, HoldFoldVerdict } from "@/app/api/holdfold/route";

function makeVerdict(overrides: Partial<HoldFoldVerdict>): HoldFoldVerdict {
  return {
    ticker: "AAPL",
    verdict: "HOLD EM",
    confidence: 78,
    confidenceLabel: "HIGH",
    bias: "bullish",
    industry: "Consumer Electronics",
    rsi: 61.2,
    macd: 1.4,
    adx: 28.9,
    price: 190.5,
    high52w: 199,
    low52w: 150,
    returns: {},
    signals: [{ signal: "RSI overbought", strength: "BULLISH", detail: "d", category: "momentum" }],
    aiSummary: "summary",
    aiOutlook: "Outlook text",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const payload: HoldFoldPayload = {
  verdicts: [
    makeVerdict({ ticker: "AAPL", industry: "Consumer Electronics", verdict: "HOLD EM" }),
    makeVerdict({ ticker: "TSLA", industry: "Automotive", verdict: "FOLD EM", bias: "bearish" }),
    makeVerdict({ ticker: "XOM", industry: "Energy", verdict: "NEUTRAL", bias: "neutral" }),
  ],
  total: 3,
  holdCount: 1,
  foldCount: 1,
  neutralCount: 1,
  updatedAt: new Date().toISOString(),
};

describe("HoldFoldClient", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders every verdict row", () => {
    render(<HoldFoldClient data={payload} />);
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("TSLA")).toBeInTheDocument();
    expect(screen.getByText("XOM")).toBeInTheDocument();
  });

  it("search narrows the list by ticker (case-insensitive)", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);
    await user.type(screen.getByPlaceholderText("Search ticker or industry…"), "aapl");
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.queryByText("TSLA")).not.toBeInTheDocument();
  });

  it("search narrows the list by industry", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);
    await user.type(screen.getByPlaceholderText("Search ticker or industry…"), "energy");
    expect(screen.getByText("XOM")).toBeInTheDocument();
    expect(screen.queryByText("AAPL")).not.toBeInTheDocument();
  });

  it("filter tabs narrow to only that verdict bucket", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);
    await user.click(screen.getByRole("button", { name: "FOLD EM" }));
    expect(screen.getByText("TSLA")).toBeInTheDocument();
    expect(screen.queryByText("AAPL")).not.toBeInTheDocument();
    expect(screen.queryByText("XOM")).not.toBeInTheDocument();
  });

  it("search and filter compose together", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);
    await user.click(screen.getByRole("button", { name: "FOLD EM" }));
    await user.type(screen.getByPlaceholderText("Search ticker or industry…"), "AAPL");
    expect(screen.getByText("No tickers match your search.")).toBeInTheDocument();
  });

  it("shows an empty-state message when no rows match", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);
    await user.type(screen.getByPlaceholderText("Search ticker or industry…"), "ZZZZ");
    expect(screen.getByText("No tickers match your search.")).toBeInTheDocument();
  });

  it("clicking a row opens its detail panel; clicking it again closes it", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);

    await user.click(screen.getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
    expect(screen.getByText("AI OUTLOOK")).toBeInTheDocument();
    expect(screen.getByText("Outlook text")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
    expect(screen.queryByText("AI OUTLOOK")).not.toBeInTheDocument();
  });

  it("the close (✕) button in the detail panel closes it", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);
    await user.click(screen.getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("AI OUTLOOK")).not.toBeInTheDocument();
  });

  it("selecting a different row swaps the detail panel content", async () => {
    const user = userEvent.setup();
    render(<HoldFoldClient data={payload} />);
    await user.click(screen.getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
    expect(screen.getByText("Outlook text")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /TSLA.*Automotive/ }));
    // still only one detail panel, now for TSLA
    expect(screen.getAllByText("Outlook text")).toHaveLength(1);
  });

  describe("watchlist button", () => {
    async function openDetail(user: ReturnType<typeof userEvent.setup>) {
      render(<HoldFoldClient data={payload} />);
      await user.click(screen.getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
      return screen.getByRole("button", { name: "+ Watchlist" });
    }

    it("adds to watchlist and disables the button once added", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
      const user = userEvent.setup();
      const btn = await openDetail(user);

      await user.click(btn);

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/portfolio/watchlist",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ ticker: "AAPL" }) }),
      );
      const done = await screen.findByRole("button", { name: "✓ Watching" });
      expect(done).toBeDisabled();
    });

    it("treats HTTP 409 (already on watchlist) as success", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) } as Response);
      const user = userEvent.setup();
      const btn = await openDetail(user);
      await user.click(btn);
      expect(await screen.findByRole("button", { name: "✓ Watching" })).toBeInTheDocument();
    });

    it("shows a retry state on failure and allows retrying", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: "server exploded" }),
      } as Response);
      const user = userEvent.setup();
      const btn = await openDetail(user);
      await user.click(btn);

      const retryBtn = await screen.findByRole("button", { name: "↺ Retry" });
      expect(retryBtn).toHaveAttribute("title", "server exploded");
      expect(retryBtn).toBeEnabled();
    });

    it("disables the button while the add request is in flight", async () => {
      let resolveFetch: (v: unknown) => void = () => {};
      global.fetch = vi.fn().mockReturnValue(new Promise((r) => { resolveFetch = r; }));
      const user = userEvent.setup();
      const btn = await openDetail(user);
      await user.click(btn);

      expect(screen.getByRole("button", { name: "Adding…" })).toBeDisabled();
      resolveFetch({ ok: true, status: 200, json: async () => ({}) });
      await screen.findByRole("button", { name: "✓ Watching" });
    });
  });

  describe("council seat panel", () => {
    async function openDetail(user: ReturnType<typeof userEvent.setup>) {
      render(<HoldFoldClient data={payload} />);
      await user.click(screen.getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
    }

    it("asks the T1 council seat and renders the structured verdict", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          verdict: {
            outlook: "bullish",
            because: "strong momentum",
            invalidation: "close below 180",
            execution: "entry 190 / stop 180 / target 210",
          },
          model: "anthropic/claude-opus-4-8",
        }),
      } as Response);
      const user = userEvent.setup();
      await openDetail(user);

      await user.click(screen.getByRole("button", { name: "Short-Term (T1)" }));

      expect(global.fetch).toHaveBeenCalledWith(
        "/api/council",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"seat":"T1"'),
        }),
      );
      expect(await screen.findByText("strong momentum")).toBeInTheDocument();
      expect(screen.getByText("close below 180")).toBeInTheDocument();
      expect(screen.getByText(/claude-opus-4-8/)).toBeInTheDocument();
    });

    it("shows the loading label while consulting the council", async () => {
      let resolveFetch: (v: unknown) => void = () => {};
      global.fetch = vi.fn().mockReturnValue(new Promise((r) => { resolveFetch = r; }));
      const user = userEvent.setup();
      await openDetail(user);

      await user.click(screen.getByRole("button", { name: "Short-Term (T1)" }));
      expect(screen.getByRole("button", { name: "Consulting…" })).toBeDisabled();

      resolveFetch({
        ok: true,
        status: 200,
        json: async () => ({ verdict: { outlook: "x", because: "y", invalidation: "z", execution: "w" } }),
      });
      await screen.findByText("y");
    });

    it("maps a known error code to a friendly message", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: "council_response_invalid" }),
      } as Response);
      const user = userEvent.setup();
      await openDetail(user);

      await user.click(screen.getByRole("button", { name: "Short-Term (T1)" }));
      expect(
        await screen.findByText(/didn't come back in a usable format/i),
      ).toBeInTheDocument();
    });

    it("falls back to a generic HTTP-status message for unknown error codes", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: "something_else" }),
      } as Response);
      const user = userEvent.setup();
      await openDetail(user);

      await user.click(screen.getByRole("button", { name: "Short-Term (T1)" }));
      expect(await screen.findByText("Council unavailable (HTTP 503).")).toBeInTheDocument();
    });

    it("shows a network-error message when the request itself throws", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("offline"));
      const user = userEvent.setup();
      await openDetail(user);

      await user.click(screen.getByRole("button", { name: "Short-Term (T1)" }));
      expect(
        await screen.findByText("Network error — council unavailable."),
      ).toBeInTheDocument();
    });

    it("T1 and T2 seats are independent — asking one doesn't affect the other's state", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          verdict: { outlook: "bullish", because: "t1 reason", invalidation: "i", execution: "e" },
        }),
      } as Response);
      const user = userEvent.setup();
      await openDetail(user);

      await user.click(screen.getByRole("button", { name: "Short-Term (T1)" }));
      expect(await screen.findByText("t1 reason")).toBeInTheDocument();
      // T2 seat button is unaffected and still shows its idle label
      expect(screen.getByRole("button", { name: "Long-Term (T2)" })).toBeInTheDocument();
    });
  });
});
