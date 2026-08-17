import { describe, expect, it } from "vitest";
import { buildSignalCard, formatSignalForShare } from "@/lib/signalCard";
import type { SignalPayload } from "@/lib/digest";

function signal(overrides: Partial<SignalPayload> = {}): SignalPayload {
  return {
    id: "sig-1",
    ticker: "NVDA",
    direction: "bullish",
    timeframe: "short",
    confidence: "high",
    title: "NVDA breaks out",
    explanation: "RSI and MACD confirm.",
    indicators: ["RSI"],
    generatedAt: "2026-07-01T00:00:00.000Z",
    isStale: false,
    ...overrides,
  };
}

describe("buildSignalCard", () => {
  it("builds an image URL carrying ticker, direction, confidence and timeframe", () => {
    const { imageUrl } = buildSignalCard(signal(), "https://portal.example.com", "https://app.example.com");
    const url = new URL(imageUrl);
    expect(url.pathname).toBe("/api/signals/card");
    expect(url.searchParams.get("ticker")).toBe("NVDA");
    expect(url.searchParams.get("direction")).toBe("bullish");
    expect(url.searchParams.get("confidence")).toBe("high");
    expect(url.searchParams.get("timeframe")).toBe("short");
  });

  it("builds a share URL deep-linking to the signal's anchor on the signals page", () => {
    const { shareUrl } = buildSignalCard(signal({ id: "abc-123" }), "https://portal.example.com", "x");
    expect(shareUrl).toBe("https://portal.example.com/dashboard/signals#signal-abc-123");
  });

  it("strips a trailing slash from the base URL so paths never double up", () => {
    const { imageUrl, shareUrl } = buildSignalCard(signal(), "https://portal.example.com/", "x");
    expect(imageUrl).not.toContain("//api/");
    expect(shareUrl).not.toContain("//dashboard/");
    expect(shareUrl.startsWith("https://portal.example.com/dashboard/")).toBe(true);
  });

  it("percent-encodes ticker characters that are unsafe in a query string", () => {
    const { imageUrl } = buildSignalCard(signal({ ticker: "A&B C" }), "https://p.example.com", "x");
    expect(imageUrl).toContain("ticker=A%26B+C");
    // and it round-trips back to the original value
    expect(new URL(imageUrl).searchParams.get("ticker")).toBe("A&B C");
  });

  it("derives both URLs from the portal base — the app base argument is not used", () => {
    const card = buildSignalCard(signal(), "https://portal.example.com", "https://app.example.com");
    expect(card.imageUrl).toContain("portal.example.com");
    expect(card.shareUrl).toContain("portal.example.com");
    expect(card.imageUrl).not.toContain("app.example.com");
    expect(card.shareUrl).not.toContain("app.example.com");
  });

  it("passes the original signal through untouched", () => {
    const s = signal();
    expect(buildSignalCard(s, "https://p.example.com", "x").signal).toBe(s);
  });
});

describe("formatSignalForShare", () => {
  it.each([
    ["bullish", "📈"],
    ["bearish", "📉"],
    ["neutral", "➡️"],
  ] as const)("uses the %s arrow", (direction, arrow) => {
    expect(formatSignalForShare(signal({ direction })).startsWith(arrow)).toBe(true);
  });

  it("renders ticker, upper-cased direction and confidence", () => {
    expect(formatSignalForShare(signal({ ticker: "AAPL", direction: "bearish", confidence: "low" }))).toBe(
      "📉 AAPL BEARISH (low confidence)",
    );
  });
});
