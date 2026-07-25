import { describe, expect, it } from "vitest";
import { hashIp, clientIpFromHeaders, MAX_DEMO_PER_IP_PER_DAY } from "@/lib/shared/public-demo-policy";

describe("hashIp", () => {
  it("is deterministic for the same input", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
  });

  it("differs for different inputs", () => {
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("5.6.7.8"));
  });

  it("never returns the raw input (one-way)", () => {
    const ip = "203.0.113.42";
    expect(hashIp(ip)).not.toContain(ip);
  });

  it("produces a 64-char hex sha256 digest", () => {
    expect(hashIp("1.2.3.4")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("clientIpFromHeaders", () => {
  it("prefers the first x-forwarded-for entry", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.1");
  });

  it("falls back to x-real-ip", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.9" });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.9");
  });

  it("falls back to 'unknown' when neither header is present", () => {
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("MAX_DEMO_PER_IP_PER_DAY", () => {
  it("is a small, sane cap", () => {
    expect(MAX_DEMO_PER_IP_PER_DAY).toBe(1);
  });
});
