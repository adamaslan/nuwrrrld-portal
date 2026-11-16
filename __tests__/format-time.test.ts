import { describe, expect, it } from "vitest";
import { formatRunTimeET } from "@/lib/format-time";

describe("formatRunTimeET", () => {
  it("renders UTC input as labeled Eastern time (standard time)", () => {
    // 18:45:41 UTC on Nov 1, 2026 = 1:45:41 PM EST (DST ended 2am that day)
    expect(formatRunTimeET("2026-11-01T18:45:41Z")).toBe("Nov 1, 2026, 1:45:41 PM EST");
  });

  it("handles the DST boundary correctly (EDT before the Nov 1, 2026 fallback)", () => {
    // 01:21:06 UTC on Nov 1, 2026 = Oct 31, 9:21:06 PM EDT
    expect(formatRunTimeET("2026-11-01T01:21:06Z")).toBe("Oct 31, 2026, 9:21:06 PM EDT");
    // 06:00 UTC = 1:00 AM EST (after the 2am fallback)
    expect(formatRunTimeET("2026-11-01T06:00:00Z")).toBe("Nov 1, 2026, 1:00:00 AM EST");
  });

  it("never emits a zone-less ambiguous string, and says unknown for garbage", () => {
    expect(formatRunTimeET("2026-11-01T18:45:41Z")).toMatch(/E[DS]T$/);
    expect(formatRunTimeET("not-a-date")).toBe("time unknown");
  });
});
