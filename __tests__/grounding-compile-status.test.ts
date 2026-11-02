import { describe, expect, it } from "vitest";
import { extractionFailureMessage } from "../scripts/lib/grounding-compile-status.mjs";

describe("grounding compile exit status", () => {
  it("reports a live partial extraction failure with the failed and attempted counts", () => {
    expect(extractionFailureMessage({ dryRun: false, callsMade: 40, extractFailures: 37 }))
      .toBe("37 of 40 extraction calls failed; failed chunks were not persisted and existing rows were left intact");
  });

  it("reports when every live extraction call fails", () => {
    expect(extractionFailureMessage({ dryRun: false, callsMade: 4, extractFailures: 4 }))
      .toBe("all 4 extraction calls failed; failed chunks were not persisted and existing rows were left intact");
  });

  it("allows an incremental run that deferred work only because of its call budget", () => {
    expect(extractionFailureMessage({ dryRun: false, callsMade: 40, extractFailures: 0 })).toBeNull();
  });

  it("reports no failure for a dry run even when extraction calls failed", () => {
    expect(extractionFailureMessage({ dryRun: true, callsMade: 40, extractFailures: 37 })).toBeNull();
  });
});
