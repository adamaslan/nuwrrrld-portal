import { describe, expect, it } from "vitest";
import { hashIp, clientIpFromHeaders, MAX_DEMO_PER_IP_PER_DAY } from "@/lib/shared/public-demo-policy";

const SECRET = "test-only-secret";

describe("hashIp", () => {
  it("is deterministic for the same input and secret", () => {
    expect(hashIp("1.2.3.4", SECRET)).toBe(hashIp("1.2.3.4", SECRET));
  });

  it("differs for different IPs", () => {
    expect(hashIp("1.2.3.4", SECRET)).not.toBe(hashIp("5.6.7.8", SECRET));
  });

  it("differs for different secrets (proves it's keyed, not plain SHA-256)", () => {
    expect(hashIp("1.2.3.4", SECRET)).not.toBe(hashIp("1.2.3.4", "a-different-secret"));
  });

  it("never returns the raw input (one-way)", () => {
    const ip = "203.0.113.42";
    expect(hashIp(ip, SECRET)).not.toContain(ip);
  });

  it("produces a 64-char hex HMAC-SHA256 digest", () => {
    expect(hashIp("1.2.3.4", SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("clientIpFromHeaders", () => {
  it("trusts x-real-ip (the platform-set header)", () => {
    const headers = new Headers({ "x-real-ip": "203.0.113.9" });
    expect(clientIpFromHeaders(headers)).toBe("203.0.113.9");
  });

  it("ignores client-supplied x-forwarded-for (spoofable, would let a caller rotate IPs to bypass the quota)", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" });
    expect(clientIpFromHeaders(headers)).toBe("unknown");
  });

  it("falls back to 'unknown' when no trusted header is present", () => {
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});

describe("MAX_DEMO_PER_IP_PER_DAY", () => {
  it("is a small, sane cap", () => {
    expect(MAX_DEMO_PER_IP_PER_DAY).toBe(1);
  });
});
