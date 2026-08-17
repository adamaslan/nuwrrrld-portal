import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SignalShareButton } from "./SignalShareButton";
import type { SignalPayload } from "@/lib/digest";

const signal: SignalPayload = {
  id: "sig-1",
  ticker: "NVDA",
  direction: "bullish",
  timeframe: "short",
  confidence: "high",
  title: "NVDA breaks out",
  explanation: "RSI and MACD both confirm.",
  indicators: ["RSI", "MACD"],
  generatedAt: new Date().toISOString(),
  isStale: false,
};

// jsdom (v29+) ships a real navigator.clipboard/share. `Object.defineProperty`
// (not plain assignment) is required to override them, and — because jsdom
// resets its Clipboard stub on genuine user-activation-driven pointer events —
// we click with `fireEvent` here rather than `userEvent`, which dispatches a
// fuller (real-activation) pointer sequence that triggers that reset mid-click.
function stubNavigator(props: { share?: typeof navigator.share; clipboard?: unknown }) {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  }
}

function unstubNavigator(...keys: Array<"share" | "clipboard">) {
  for (const key of keys) {
    delete navigator[key];
  }
}

describe("SignalShareButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    unstubNavigator("share", "clipboard");
  });

  it("prefers the native share sheet when navigator.share is available", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share });

    render(<SignalShareButton signal={signal} />);
    fireEvent.click(screen.getByRole("button", { name: /share/i }));

    await vi.waitFor(() =>
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: "Signal: NVDA" })),
    );
  });

  it("silently no-ops when the user cancels the native share sheet", async () => {
    const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const share = vi.fn().mockRejectedValue(abortError);
    stubNavigator({ share });

    render(<SignalShareButton signal={signal} />);
    fireEvent.click(screen.getByRole("button", { name: /share/i }));

    await vi.waitFor(() => expect(share).toHaveBeenCalled());
    expect(screen.getByRole("button")).toHaveTextContent("📤 Share");
  });

  it("falls back to clipboard when navigator.share is unavailable", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share: undefined, clipboard: { writeText } });

    render(<SignalShareButton signal={signal} />);
    fireEvent.click(screen.getByRole("button", { name: /share/i }));

    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("NVDA"));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("/dashboard/signals#signal-sig-1"),
    );
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it("reverts the 'Copied' label back to 'Share' after the timeout", async () => {
    // Spy on setTimeout and invoke the captured callback directly, rather than
    // faking the clock: the writeText mock's promise resolution needs a real
    // microtask flush, and mixing that with fake-timer macrotask advancement
    // makes the ordering unreliable. This asserts the *contract* (a 2000ms
    // revert timer is scheduled and firing it flips the label back) without
    // depending on exact clock/microtask interleaving.
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ share: undefined, clipboard: { writeText } });

    render(<SignalShareButton signal={signal} />);
    fireEvent.click(screen.getByRole("button", { name: /share/i }));
    expect(await screen.findByRole("button", { name: /copied/i })).toBeInTheDocument();

    const revertCall = timeoutSpy.mock.calls.find(([, delay]) => delay === 2000);
    expect(revertCall).toBeDefined();
    const [revertCallback] = revertCall!;
    await act(async () => {
      (revertCallback as () => void)();
    });

    expect(screen.getByRole("button")).toHaveTextContent("📤 Share");
  });

  it("alerts the user when the clipboard write itself fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    stubNavigator({ share: undefined, clipboard: { writeText } });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});

    render(<SignalShareButton signal={signal} />);
    fireEvent.click(screen.getByRole("button", { name: /share/i }));

    await vi.waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith("Failed to copy share link"),
    );
    expect(screen.getByRole("button")).toHaveTextContent("📤 Share");
  });
});
