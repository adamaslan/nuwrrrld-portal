/**
 * consent.test.ts — unit tests for lib/shared/consent.ts
 * Covers the pure consent model: building, parsing, checking permissions, and GPC/DNT.
 */

import { describe, it, expect } from "vitest";
import {
  buildConsent,
  acceptAll,
  rejectAll,
  parseConsent,
  needsPrompt,
  isAllowed,
  applyDoNotTrack,
  CONSENT_VERSION,
  CONSENT_CATEGORIES,
  ConsentRecord,
} from "@/lib/shared/consent";

describe("consent model", () => {
  describe("buildConsent", () => {
    it("default source produces required=true, others false", () => {
      const record = buildConsent({}, "default");
      expect(record.choices.strictly_necessary).toBe(true);
      expect(record.choices.preferences).toBe(false);
      expect(record.choices.analytics).toBe(false);
      expect(record.choices.marketing).toBe(false);
    });

    it("preferences source with analytics=true sets analytics but not marketing", () => {
      const record = buildConsent({ analytics: true }, "preferences");
      expect(record.choices.strictly_necessary).toBe(true);
      expect(record.choices.analytics).toBe(true);
      expect(record.choices.preferences).toBe(false);
      expect(record.choices.marketing).toBe(false);
    });

    it("always forces strictly_necessary=true regardless of input", () => {
      const record = buildConsent(
        { strictly_necessary: false } as any,
        "preferences",
      );
      expect(record.choices.strictly_necessary).toBe(true);
    });

    it("includes CONSENT_VERSION and timestamp", () => {
      const now = new Date("2026-08-29T12:00:00Z");
      const record = buildConsent({}, "default", now);
      expect(record.v).toBe(CONSENT_VERSION);
      expect(record.ts).toBe("2026-08-29T12:00:00.000Z");
    });
  });

  describe("acceptAll / rejectAll symmetry", () => {
    it("acceptAll sets all to true except necessary which is always true", () => {
      const record = acceptAll();
      expect(record.choices.strictly_necessary).toBe(true);
      expect(record.choices.preferences).toBe(true);
      expect(record.choices.analytics).toBe(true);
      expect(record.choices.marketing).toBe(true);
    });

    it("rejectAll keeps only strictly_necessary true", () => {
      const record = rejectAll();
      expect(record.choices.strictly_necessary).toBe(true);
      expect(record.choices.preferences).toBe(false);
      expect(record.choices.analytics).toBe(false);
      expect(record.choices.marketing).toBe(false);
    });

    it("acceptAll and rejectAll have the same keys and opposite values for non-necessary", () => {
      const all = acceptAll();
      const none = rejectAll();

      for (const cat of CONSENT_CATEGORIES) {
        if (cat === "strictly_necessary") {
          expect(all.choices[cat]).toBe(true);
          expect(none.choices[cat]).toBe(true);
        } else {
          expect(all.choices[cat]).toBe(true);
          expect(none.choices[cat]).toBe(false);
        }
      }
    });

    it("both have the same source field pattern", () => {
      const all = acceptAll();
      const none = rejectAll();
      expect(all.v).toBe(none.v);
      expect(all.source).toBe("banner_accept_all");
      expect(none.source).toBe("banner_reject_all");
    });
  });

  describe("parseConsent", () => {
    it("returns null for null input", () => {
      expect(parseConsent(null)).toBe(null);
    });

    it("returns null for undefined input", () => {
      expect(parseConsent(undefined)).toBe(null);
    });

    it("returns null for malformed JSON", () => {
      expect(parseConsent("{not json")).toBe(null);
    });

    it("returns null for missing choices", () => {
      expect(parseConsent('{"v":"1.0"}')).toBe(null);
    });

    it("returns null for object without v or ts", () => {
      const record = buildConsent({}, "default");
      const broken = JSON.stringify({
        choices: record.choices,
        source: "default",
      });
      expect(parseConsent(broken)).toBe(null);
    });

    it("returns null if any category is missing from choices", () => {
      const record = buildConsent({}, "default");
      const broken = {
        v: record.v,
        ts: record.ts,
        source: record.source,
        choices: { strictly_necessary: true, preferences: false },
      };
      expect(parseConsent(JSON.stringify(broken))).toBe(null);
    });

    it("parses a valid record correctly", () => {
      const original = acceptAll();
      const json = JSON.stringify(original);
      const parsed = parseConsent(json);
      expect(parsed).not.toBeNull();
      expect(parsed!.v).toBe(original.v);
      expect(parsed!.ts).toBe(original.ts);
      expect(parsed!.choices).toEqual(original.choices);
    });

    it("forces strictly_necessary=true even if stored as false", () => {
      const record: ConsentRecord = {
        v: CONSENT_VERSION,
        ts: new Date().toISOString(),
        source: "preferences",
        choices: {
          strictly_necessary: false as any,
          preferences: true,
          analytics: true,
          marketing: false,
        },
      };
      const parsed = parseConsent(JSON.stringify(record));
      expect(parsed).not.toBeNull();
      expect(parsed!.choices.strictly_necessary).toBe(true);
    });

    it("maps unknown source to 'default'", () => {
      const record: ConsentRecord = {
        v: CONSENT_VERSION,
        ts: new Date().toISOString(),
        source: "preferences",
        choices: {
          strictly_necessary: true,
          preferences: true,
          analytics: true,
          marketing: false,
        },
      };
      const json = JSON.stringify(record);
      // Manually inject an unknown source
      const obj = JSON.parse(json);
      obj.source = "unknown_source";
      const parsed = parseConsent(JSON.stringify(obj));
      expect(parsed).not.toBeNull();
      expect(parsed!.source).toBe("default");
    });
  });

  describe("needsPrompt", () => {
    it("returns true for null", () => {
      expect(needsPrompt(null)).toBe(true);
    });

    it("returns true for record with old version", () => {
      const record: ConsentRecord = {
        v: "0.9",
        ts: new Date().toISOString(),
        source: "preferences",
        choices: {
          strictly_necessary: true,
          preferences: true,
          analytics: true,
          marketing: false,
        },
      };
      expect(needsPrompt(record)).toBe(true);
    });

    it("returns false for current-version record", () => {
      const record = acceptAll();
      expect(needsPrompt(record)).toBe(false);
    });
  });

  describe("applyDoNotTrack", () => {
    it("sets analytics and marketing to false when applying GPC", () => {
      const base = acceptAll();
      const result = applyDoNotTrack(base, "gpc");
      expect(result.choices.strictly_necessary).toBe(true);
      expect(result.choices.preferences).toBe(true);
      expect(result.choices.analytics).toBe(false);
      expect(result.choices.marketing).toBe(false);
    });

    it("sets analytics and marketing to false when applying DNT", () => {
      const base = acceptAll();
      const result = applyDoNotTrack(base, "dnt");
      expect(result.choices.analytics).toBe(false);
      expect(result.choices.marketing).toBe(false);
    });

    it("preserves preferences choice from base", () => {
      const base = buildConsent({ preferences: true }, "preferences");
      const result = applyDoNotTrack(base, "gpc");
      expect(result.choices.preferences).toBe(true);
    });

    it("handles null base by treating preferences as false", () => {
      const result = applyDoNotTrack(null, "gpc");
      expect(result.choices.preferences).toBe(false);
    });

    it("sets source to gpc or dnt respectively", () => {
      const base = acceptAll();
      const gpc = applyDoNotTrack(base, "gpc");
      const dnt = applyDoNotTrack(base, "dnt");
      expect(gpc.source).toBe("gpc");
      expect(dnt.source).toBe("dnt");
    });
  });

  describe("isAllowed", () => {
    it("always allows strictly_necessary regardless of record", () => {
      expect(isAllowed(null, "strictly_necessary")).toBe(true);
      expect(isAllowed(rejectAll(), "strictly_necessary")).toBe(true);
      expect(isAllowed(acceptAll(), "strictly_necessary")).toBe(true);
    });

    it("disallows any non-necessary category when record is null", () => {
      expect(isAllowed(null, "preferences")).toBe(false);
      expect(isAllowed(null, "analytics")).toBe(false);
      expect(isAllowed(null, "marketing")).toBe(false);
    });

    it("disallows non-necessary categories when record is old version", () => {
      const old: ConsentRecord = {
        v: "0.9",
        ts: new Date().toISOString(),
        source: "default",
        choices: {
          strictly_necessary: true,
          preferences: true,
          analytics: true,
          marketing: true,
        },
      };
      expect(isAllowed(old, "analytics")).toBe(false);
      expect(isAllowed(old, "marketing")).toBe(false);
    });

    it("allows categories that are true in current-version record", () => {
      const record = acceptAll();
      expect(isAllowed(record, "preferences")).toBe(true);
      expect(isAllowed(record, "analytics")).toBe(true);
      expect(isAllowed(record, "marketing")).toBe(true);
    });

    it("disallows categories that are false in current-version record", () => {
      const record = rejectAll();
      expect(isAllowed(record, "preferences")).toBe(false);
      expect(isAllowed(record, "analytics")).toBe(false);
      expect(isAllowed(record, "marketing")).toBe(false);
    });
  });
});
