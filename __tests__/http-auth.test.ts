import { describe, it, expect } from "vitest";
import { timingSafeEqualStr, bearerTokenMatches } from "@/lib/http-auth";

describe("timingSafeEqualStr", () => {
  it("is true for identical strings", () => {
    expect(timingSafeEqualStr("hunter2", "hunter2")).toBe(true);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });

  it("is false for different strings of equal length", () => {
    expect(timingSafeEqualStr("hunter2", "hunter3")).toBe(false);
  });

  it("is false for different lengths (without throwing)", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-value")).toBe(false);
    expect(timingSafeEqualStr("a-much-longer-value", "short")).toBe(false);
    expect(timingSafeEqualStr("prefix", "prefix-extra")).toBe(false);
  });

  it("is false when only one side is empty", () => {
    expect(timingSafeEqualStr("", "x")).toBe(false);
    expect(timingSafeEqualStr("x", "")).toBe(false);
  });

  it("handles multi-byte UTF-8 without throwing", () => {
    expect(timingSafeEqualStr("café", "café")).toBe(true);
    expect(timingSafeEqualStr("café", "cafe")).toBe(false);
  });
});

describe("bearerTokenMatches", () => {
  const SECRET = "s3cr3t-token-value";

  it("matches a correct Bearer header", () => {
    expect(bearerTokenMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(bearerTokenMatches(`Bearer wrong-value-here`, SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(bearerTokenMatches(null, SECRET)).toBe(false);
    expect(bearerTokenMatches(undefined, SECRET)).toBe(false);
    expect(bearerTokenMatches("", SECRET)).toBe(false);
    expect(bearerTokenMatches(SECRET, SECRET)).toBe(false); // no "Bearer " prefix
    expect(bearerTokenMatches(`bearer ${SECRET}`, SECRET)).toBe(false); // case-sensitive scheme
    expect(bearerTokenMatches(`Bearer  ${SECRET}`, SECRET)).toBe(false); // extra space
  });

  it("never authenticates when the secret is unset", () => {
    expect(bearerTokenMatches("Bearer ", "")).toBe(false);
    expect(bearerTokenMatches("Bearer undefined", undefined)).toBe(false);
    expect(bearerTokenMatches("Bearer null", null)).toBe(false);
  });
});
