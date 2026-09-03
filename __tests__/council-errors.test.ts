import { describe, expect, it } from "vitest";
import { councilErrorMessage, COUNCIL_ERROR_MESSAGES } from "@/lib/shared/councilErrors";

describe("councilErrorMessage", () => {
  it("maps every known code to its sentence", () => {
    for (const [code, msg] of Object.entries(COUNCIL_ERROR_MESSAGES)) {
      expect(councilErrorMessage(code, 500)).toBe(msg);
    }
  });

  it("falls back to the status for an unknown code", () => {
    expect(councilErrorMessage("something_else", 503)).toBe("Council unavailable (HTTP 503).");
  });

  it("falls back for a non-string code", () => {
    expect(councilErrorMessage(undefined, 500)).toBe("Council unavailable (HTTP 500).");
    expect(councilErrorMessage(42, 500)).toBe("Council unavailable (HTTP 500).");
    expect(councilErrorMessage({ error: "x" }, 500)).toBe("Council unavailable (HTTP 500).");
  });

  it("does not return inherited Object.prototype members", () => {
    // A JSON body can carry any key. Without an own-property check these
    // return a function / object, which then lands in React state where a
    // string is expected.
    for (const key of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      const out = councilErrorMessage(key, 502);
      expect(typeof out).toBe("string");
      expect(out).toBe("Council unavailable (HTTP 502).");
    }
  });
});
