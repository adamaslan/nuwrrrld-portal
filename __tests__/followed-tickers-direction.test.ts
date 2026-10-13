import { describe, expect, it } from "vitest";
import { directionFromAction, directionFromCard } from "@/lib/shared/followed-tickers-direction";

const card = (barDate: string, direction?: string) => ({ barDate, tokens: { direction } });

describe("directionFromCard", () => {
  it("maps bullish and bearish tokens on a fresh card", () => {
    expect(directionFromCard(card("2026-10-13", "bullish"), "2026-10-13")).toBe("bull");
    expect(directionFromCard(card("2026-10-12", "bearish"), "2026-10-13")).toBe("bear");
  });
  it("returns null for a stale, future, neutral or missing card", () => {
    expect(directionFromCard(card("2026-10-01", "bullish"), "2026-10-13")).toBeNull();
    expect(directionFromCard(card("2026-10-14", "bullish"), "2026-10-13")).toBeNull();
    expect(directionFromCard(card("2026-10-13", "neutral"), "2026-10-13")).toBeNull();
    expect(directionFromCard(null, "2026-10-13")).toBeNull();
  });
});

describe("directionFromAction", () => {
  it("maps buy/sell labels and ignores everything else", () => {
    expect(directionFromAction("STRONG BUY")).toBe("bull");
    expect(directionFromAction("sell")).toBe("bear");
    expect(directionFromAction("HOLD")).toBeNull();
    expect(directionFromAction(undefined)).toBeNull();
  });
});
