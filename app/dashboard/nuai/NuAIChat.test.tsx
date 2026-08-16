import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuAIChat } from "./NuAIChat";

function jsonResponse(body: unknown, init: Partial<Response> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    ...init,
  } as unknown as Response;
}

describe("NuAIChat", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the empty state with suggested prompt chips and the disclaimer", () => {
    render(<NuAIChat />);
    expect(screen.getByText("Nu AI")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Explain today's signals" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/informational responses only/i)).toBeInTheDocument();
  });

  it("disables send when input is blank, enables once text is typed", async () => {
    render(<NuAIChat />);
    const send = screen.getByRole("button", { name: "↑" });
    expect(send).toBeDisabled();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Ask Nu AI…"), "hi");
    expect(send).toBeEnabled();
  });

  it("sends a message, renders the assistant reply, and clears the composer", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: { role: "assistant", content: "Signals look calm today.", timestamp: new Date().toISOString() } }),
    );
    const user = userEvent.setup();
    render(<NuAIChat />);

    const textarea = screen.getByPlaceholderText("Ask Nu AI…");
    await user.type(textarea, "Explain today's signals");
    await user.click(screen.getByRole("button", { name: "↑" }));

    expect(await screen.findByText("Signals look calm today.")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
    // user bubble for the sent message is also rendered
    expect(screen.getByText("Explain today's signals")).toBeInTheDocument();
  });

  it("clicking a suggested prompt chip sends that prompt directly", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: { role: "assistant", content: "Sure — here's the tone.", timestamp: new Date().toISOString() } }),
    );
    const user = userEvent.setup();
    render(<NuAIChat />);

    await user.click(screen.getByRole("button", { name: "What's the market tone?" }));

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/nuai",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("What's the market tone?"),
      }),
    );
    expect(await screen.findByText("Sure — here's the tone.")).toBeInTheDocument();
  });

  it("shows the daily-limit screen on HTTP 429 and locks out further chat", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429 } as Response);
    const user = userEvent.setup();
    render(<NuAIChat />);

    await user.type(screen.getByPlaceholderText("Ask Nu AI…"), "one more question");
    await user.click(screen.getByRole("button", { name: "↑" }));

    expect(await screen.findByText("Daily limit reached")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Ask Nu AI…")).not.toBeInTheDocument();
  });

  it("shows an upgrade-required error on HTTP 403", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "upgrade_required" }),
    } as Response);
    const user = userEvent.setup();
    render(<NuAIChat />);

    await user.type(screen.getByPlaceholderText("Ask Nu AI…"), "question");
    await user.click(screen.getByRole("button", { name: "↑" }));

    expect(
      await screen.findByText("Nu AI requires a Pro subscription. Upgrade to continue."),
    ).toBeInTheDocument();
  });

  it("shows a generic error and removes the empty placeholder bubble on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    render(<NuAIChat />);

    await user.type(screen.getByPlaceholderText("Ask Nu AI…"), "question");
    await user.click(screen.getByRole("button", { name: "↑" }));

    expect(await screen.findByText("offline")).toBeInTheDocument();
    // only the user's own bubble remains; the empty assistant placeholder was stripped
    expect(screen.getAllByText("question")).toHaveLength(1);
  });

  it("sends on Enter but inserts a newline on Shift+Enter instead of sending", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: { role: "assistant", content: "ok", timestamp: new Date().toISOString() } }),
    );
    const user = userEvent.setup();
    render(<NuAIChat />);

    const textarea = screen.getByPlaceholderText("Ask Nu AI…");
    await user.type(textarea, "line one{Shift>}{Enter}{/Shift}line two");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("line one\nline two");

    await user.type(textarea, "{Enter}");
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
  });

  it("scrolls to the newest message on every update", async () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ message: { role: "assistant", content: "ok", timestamp: new Date().toISOString() } }),
    );
    const user = userEvent.setup();
    render(<NuAIChat />);
    await user.type(screen.getByPlaceholderText("Ask Nu AI…"), "hi{Enter}");
    await screen.findByText("ok");
    expect(scrollSpy).toHaveBeenCalled();
  });

  // The component branches on content-type: an SSE response is drained through
  // consumeSSE and painted token-by-token into the trailing assistant bubble.
  // Everything above exercises only the non-streaming JSON fallback.
  describe("streaming (text/event-stream)", () => {
    function sseResponse(tokens: string[], { done = true } = {}): Response {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const t of tokens) {
            const frame = JSON.stringify({ choices: [{ delta: { content: t } }] });
            controller.enqueue(encoder.encode(`data: ${frame}\n`));
          }
          if (done) controller.enqueue(encoder.encode("data: [DONE]\n"));
          controller.close();
        },
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream; charset=utf-8" }),
        body,
      } as unknown as Response;
    }

    async function send(text: string) {
      const user = userEvent.setup();
      render(<NuAIChat />);
      await user.type(screen.getByPlaceholderText("Ask Nu AI…"), `${text}{Enter}`);
    }

    it("accumulates streamed tokens into a single assistant message", async () => {
      global.fetch = vi.fn().mockResolvedValue(sseResponse(["Signals ", "look ", "calm."]));
      await send("stream me");
      expect(await screen.findByText("Signals look calm.")).toBeInTheDocument();
    });

    it("renders the streamed answer alongside — not replacing — the user's message", async () => {
      global.fetch = vi.fn().mockResolvedValue(sseResponse(["done"]));
      await send("my question");
      await screen.findByText("done");
      expect(screen.getByText("my question")).toBeInTheDocument();
    });

    it("completes even when the stream ends without an explicit [DONE]", async () => {
      global.fetch = vi.fn().mockResolvedValue(sseResponse(["no terminator"], { done: false }));
      await send("stream me");
      expect(await screen.findByText("no terminator")).toBeInTheDocument();
    });

    it("re-enables the composer once the stream finishes", async () => {
      global.fetch = vi.fn().mockResolvedValue(sseResponse(["ok"]));
      await send("stream me");
      await screen.findByText("ok");
      const textarea = screen.getByPlaceholderText("Ask Nu AI…");
      expect(textarea).toHaveValue("");
      // send stays disabled only because the (now empty) composer has no text
      await userEvent.setup().type(textarea, "again");
      expect(screen.getByRole("button", { name: "↑" })).toBeEnabled();
    });

    it("surfaces an error when the stream body is missing", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "text/event-stream" }),
        body: null,
      } as unknown as Response);
      await send("stream me");
      expect(await screen.findByText("SSE response body is not readable")).toBeInTheDocument();
    });
  });
});
