import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatComputedAt, outlookLabel } from "@/lib/shared/stored-card-honesty";

// Pure presentation policy. No backend, DB or provider is called.
describe("Hold/Fold computation dates", () => {
  it("renders the same explicit UTC instant regardless of server or browser timezone", () => {
    const original = process.env.TZ;
    try {
      const dates = ["America/New_York", "Asia/Tokyo"].map(zone => {
        process.env.TZ = zone;
        return formatComputedAt("2026-11-13T02:49:03Z");
      });
      expect(dates[0]).toBe(dates[1]);
      expect(dates[0]).toMatch(/Nov 13.*2:49.*UTC/);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it("marks missing or invalid calculation dates unknown on all three surfaces", () => {
    expect(formatComputedAt("")).toBe("unknown");
    expect(formatComputedAt("not a date")).toBe("unknown");
    for (const file of ["app/dashboard/holdfold/page.tsx", "app/dashboard/holdfold/HoldFoldClient.tsx", "app/dashboard/holdfold/[ticker]/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("formatComputedAt(");
      expect(source).not.toContain("toLocaleString(");
    }
  });
});

describe("Hold/Fold outlook provenance", () => {
  it("labels only known stored card summaries as stored, never infers from text", () => {
    expect(outlookLabel("stored-card")).toBe("STORED SIGNAL SUMMARY");
    expect(outlookLabel("upstream-signal")).toBe("AI OUTLOOK");
    expect(outlookLabel(undefined)).toBe("AI OUTLOOK");
    const source = readFileSync("app/dashboard/holdfold/[ticker]/page.tsx", "utf8");
    expect(source).toContain("outlookLabel(v.outlookSource)");
  });
});
