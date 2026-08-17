import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignalAskAnything } from "./SignalAskAnything";

function mockFetchOnce(response: Partial<Response> & { jsonBody?: unknown }) {
  const { jsonBody, ...rest } = response;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => jsonBody ?? {},
    ...rest,
  } as Response);
}

describe("SignalAskAnything", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables Ask on blank input and never calls fetch", async () => {
    render(<SignalAskAnything ticker="AAPL" />);
    const askButton = screen.getByRole("button", { name: "Ask" });
    expect(askButton).toBeDisabled();

    const user = userEvent.setup();
    await user.click(askButton);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("enables Ask once text is entered, and posts to the ticker's chat endpoint", async () => {
    mockFetchOnce({ jsonBody: { answer: "AAPL looks bullish." } });
    const user = userEvent.setup();
    render(<SignalAskAnything ticker="AAPL" />);

    const input = screen.getByPlaceholderText(/ask anything about AAPL/i);
    await user.type(input, "Is it a buy?");
    const askButton = screen.getByRole("button", { name: "Ask" });
    expect(askButton).toBeEnabled();

    await user.click(askButton);

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/signals/AAPL/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Is it a buy?" }),
      }),
    );
    expect(await screen.findByText("AAPL looks bullish.")).toBeInTheDocument();
  });

  it("encodes the ticker in the request URL", async () => {
    mockFetchOnce({ jsonBody: { answer: "ok" } });
    const user = userEvent.setup();
    render(<SignalAskAnything ticker="BRK.B" />);
    await user.type(screen.getByRole("textbox"), "q");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/signals/BRK.B/chat",
      expect.anything(),
    );
  });

  it("submits on Enter key as well as button click", async () => {
    mockFetchOnce({ jsonBody: { answer: "via enter" } });
    const user = userEvent.setup();
    render(<SignalAskAnything ticker="AAPL" />);
    await user.type(screen.getByRole("textbox"), "hello{Enter}");
    expect(await screen.findByText("via enter")).toBeInTheDocument();
  });

  it("shows the server error message and preserves the typed question on failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "signal not found" }),
    } as Response);
    const user = userEvent.setup();
    render(<SignalAskAnything ticker="AAPL" />);

    const input = screen.getByRole("textbox");
    await user.type(input, "why?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(await screen.findByText("signal not found")).toBeInTheDocument();
    expect(input).toHaveValue("why?");
  });

  it("shows a network-error message when fetch itself rejects", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<SignalAskAnything ticker="AAPL" />);
    await user.type(screen.getByRole("textbox"), "why?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(
      await screen.findByText("Could not reach the signal chat agent."),
    ).toBeInTheDocument();
  });

  it("shows 'Asking…' and disables input/button while loading", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    global.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<SignalAskAnything ticker="AAPL" />);
    await user.type(screen.getByRole("textbox"), "slow question");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    expect(screen.getByRole("button", { name: "Asking…" })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();

    resolveFetch({ ok: true, status: 200, json: async () => ({ answer: "done" }) });
    expect(await screen.findByText("done")).toBeInTheDocument();
  });

  it("ignores a second click while a request is already in flight", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    global.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<SignalAskAnything ticker="AAPL" />);
    await user.type(screen.getByRole("textbox"), "q{Enter}{Enter}");

    expect(global.fetch).toHaveBeenCalledTimes(1);
    resolveFetch({ ok: true, status: 200, json: async () => ({ answer: "done" }) });
    await screen.findByText("done");
  });
});
