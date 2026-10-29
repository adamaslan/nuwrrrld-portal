import { describe, expect, it } from "vitest";
import { nyseSessionsBetween } from "@/lib/shared/nyse-calendar";

describe("nyseSessionsBetween", () => {
  it("does not count Martin Luther King Jr. Day as a session", () => {
    expect(nyseSessionsBetween(new Date("2026-01-16T00:00:00Z"), new Date("2026-01-20T00:00:00Z"))).toBe(1);
  });

  it("does not count Good Friday", () => {
    expect(nyseSessionsBetween(new Date("2026-04-02T00:00:00Z"), new Date("2026-04-06T00:00:00Z"))).toBe(1);
  });

  it("counts ordinary weekdays and skips weekends", () => {
    expect(nyseSessionsBetween(new Date("2026-09-04T00:00:00Z"), new Date("2026-09-08T00:00:00Z"))).toBe(1);
  });

  it("does not count the observed Christmas holiday across a year boundary", () => {
    expect(nyseSessionsBetween(new Date("2026-12-24T00:00:00Z"), new Date("2026-12-28T00:00:00Z"))).toBe(1);
  });

  it("returns zero for invalid or reversed date ranges", () => {
    expect(nyseSessionsBetween(new Date("invalid"), new Date("2026-01-01T00:00:00Z"))).toBe(0);
    expect(nyseSessionsBetween(new Date("2026-01-02T00:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });
});
