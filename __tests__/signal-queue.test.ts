import { describe, expect, it } from "vitest";
import {
  shouldRetry,
  MAX_ATTEMPTS,
  normalizeTicker,
  isCacheFresh,
  backoffSeconds,
  cacheTtlMinutes,
} from "@/lib/shared/signal-policy";

describe("normalizeTicker", () => {
  it("uppercases and trims a plain symbol", () => {
    expect(normalizeTicker("  nvda ")).toBe("NVDA");
  });

  it("accepts dotted and hyphenated classes", () => {
    expect(normalizeTicker("brk.b")).toBe("BRK.B");
    expect(normalizeTicker("rds-a")).toBe("RDS-A");
  });

  it("rejects non-strings", () => {
    expect(normalizeTicker(null)).toBeNull();
    expect(normalizeTicker(123)).toBeNull();
    expect(normalizeTicker(undefined)).toBeNull();
  });

  it("rejects empty, over-long, or injection-y input", () => {
    expect(normalizeTicker("")).toBeNull();
    expect(normalizeTicker("TOOLONGTICKER")).toBeNull(); // >10 chars
    expect(normalizeTicker("A B")).toBeNull();           // space
    expect(normalizeTicker("'; DROP TABLE")).toBeNull(); // starts illegal / has spaces
    expect(normalizeTicker("1AAPL")).toBeNull();         // must start with a letter
  });
});

describe("isCacheFresh", () => {
  const now = new Date("2026-07-24T12:00:00Z");

  it("is fresh within the window", () => {
    expect(isCacheFresh("2026-07-24T11:50:00Z", 15, now)).toBe(true);
  });

  it("is stale past the window", () => {
    expect(isCacheFresh("2026-07-24T11:40:00Z", 15, now)).toBe(false);
  });

  it("treats the exact boundary as fresh", () => {
    expect(isCacheFresh("2026-07-24T11:45:00Z", 15, now)).toBe(true);
  });

  it("accepts a Date as well as an ISO string", () => {
    expect(isCacheFresh(new Date("2026-07-24T11:55:00Z"), 15, now)).toBe(true);
  });

  it("treats an unparseable timestamp as not fresh", () => {
    expect(isCacheFresh("not-a-date", 15, now)).toBe(false);
  });
});

describe("shouldRetry", () => {
  it("retries while under the cap", () => {
    expect(shouldRetry(0)).toBe(true);
    expect(shouldRetry(MAX_ATTEMPTS - 1)).toBe(true);
  });

  it("stops at the cap", () => {
    expect(shouldRetry(MAX_ATTEMPTS)).toBe(false);
    expect(shouldRetry(MAX_ATTEMPTS + 1)).toBe(false);
  });

  it("honors a custom cap", () => {
    expect(shouldRetry(1, 1)).toBe(false);
    expect(shouldRetry(0, 1)).toBe(true);
  });
});

describe("backoffSeconds", () => {
  it("grows exponentially from the base", () => {
    expect(backoffSeconds(1, 30)).toBe(30);
    expect(backoffSeconds(2, 30)).toBe(60);
    expect(backoffSeconds(3, 30)).toBe(120);
  });

  it("caps at maxSeconds", () => {
    expect(backoffSeconds(20, 30, 3600)).toBe(3600);
  });

  it("treats zero/negative attempts as the first attempt", () => {
    expect(backoffSeconds(0, 30)).toBe(30);
    expect(backoffSeconds(-5, 30)).toBe(30);
  });
});

describe("cacheTtlMinutes", () => {
  it("expires hot actionable signals fast", () => {
    expect(cacheTtlMinutes({ ai_action: "STRONG BUY" })).toBe(5);
    expect(cacheTtlMinutes({ ai_action: "sell" })).toBe(5);
  });

  it("expires extreme-confluence entries fast", () => {
    expect(cacheTtlMinutes({ confluence_score: 82 })).toBe(5);
    expect(cacheTtlMinutes({ confluence_score: 12 })).toBe(5);
  });

  it("lets a quiet middle-confluence entry sit longer", () => {
    expect(cacheTtlMinutes({ ai_action: "HOLD", confluence_score: 50 })).toBe(30);
  });

  it("falls back to the default for anything unclassified", () => {
    expect(cacheTtlMinutes({})).toBe(15);
    expect(cacheTtlMinutes({ confluence_score: 62 })).toBe(15);
  });
});
