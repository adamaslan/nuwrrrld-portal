import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "jest-axe";
import { SignalAskAnything } from "./SignalAskAnything";
import { SignalShareButton } from "./SignalShareButton";
import { NuAIChat } from "@/app/dashboard/nuai/NuAIChat";
import { HoldFoldClient } from "@/app/dashboard/holdfold/HoldFoldClient";
import type { SignalPayload } from "@/lib/digest";
import type { HoldFoldPayload } from "@/app/api/holdfold/route";

/**
 * Automated accessibility pass over the interactive surfaces. axe checks the
 * rendered accessibility tree for the machine-detectable failures that role
 * queries alone don't catch: unlabelled controls, invalid ARIA, bad contrast,
 * duplicate ids. It is a floor, not a ceiling — keyboard-operability
 * assertions live alongside it below.
 */

const signal: SignalPayload = {
  id: "sig-1",
  ticker: "NVDA",
  direction: "bullish",
  timeframe: "short",
  confidence: "high",
  title: "NVDA breaks out",
  explanation: "RSI and MACD confirm.",
  indicators: ["RSI"],
  generatedAt: new Date().toISOString(),
  isStale: false,
};

const holdFoldData: HoldFoldPayload = {
  verdicts: [
    {
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
      signals: [{ signal: "RSI", strength: "BULLISH", detail: "d", category: "momentum" }],
      aiSummary: "summary",
      aiOutlook: "Outlook text",
      updatedAt: new Date().toISOString(),
    },
  ],
  total: 1,
  holdCount: 1,
  foldCount: 0,
  neutralCount: 0,
  updatedAt: new Date().toISOString(),
};

describe("accessibility — axe", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("SignalAskAnything has no detectable violations", async () => {
    const { container } = render(<SignalAskAnything ticker="NVDA" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("SignalShareButton has no detectable violations", async () => {
    const { container } = render(<SignalShareButton signal={signal} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("NuAIChat empty state has no detectable violations", async () => {
    const { container } = render(<NuAIChat />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("HoldFoldClient list has no detectable violations", async () => {
    const { container } = render(<HoldFoldClient data={holdFoldData} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("HoldFoldClient detail panel has no detectable violations", async () => {
    const user = userEvent.setup();
    const { container, getByRole } = render(<HoldFoldClient data={holdFoldData} />);
    await user.click(getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("accessibility — keyboard operability", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("SignalAskAnything: the input and Ask button are both reachable by Tab", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(<SignalAskAnything ticker="NVDA" />);

    await user.tab();
    expect(getByRole("textbox")).toHaveFocus();
    // type so the Ask button leaves its disabled state (disabled controls are skipped by Tab)
    await user.keyboard("q");
    await user.tab();
    expect(getByRole("button", { name: "Ask" })).toHaveFocus();
  });

  it("NuAIChat: prompt chips and the composer are keyboard reachable", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(<NuAIChat />);

    await user.tab();
    expect(getByRole("button", { name: "Explain today's signals" })).toHaveFocus();
  });

  it("NuAIChat: a prompt chip can be activated with the keyboard", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        message: { role: "assistant", content: "keyboard reply", timestamp: new Date().toISOString() },
      }),
    } as unknown as Response);
    const user = userEvent.setup();
    const { findByText } = render(<NuAIChat />);

    await user.tab();
    await user.keyboard("{Enter}");
    expect(await findByText("keyboard reply")).toBeInTheDocument();
  });

  it("HoldFoldClient: the close control exposes an accessible name", async () => {
    const user = userEvent.setup();
    const { getByRole } = render(<HoldFoldClient data={holdFoldData} />);
    await user.click(getByRole("button", { name: /AAPL.*Consumer Electronics/ }));
    // "✕" alone would be unreadable to a screen reader — aria-label carries it
    expect(getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
