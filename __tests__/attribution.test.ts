import { describe, it, expect } from "vitest";
import {
  buildTouch,
  parseTouch,
  serialiseTouch,
  normaliseReferrer,
  ATTRIB_VERSION,
} from "@/lib/shared/attribution";

describe("buildTouch", () => {
  it("captures UTM params and click ids", () => {
    const p = new URLSearchParams(
      "utm_source=twitter&utm_medium=social&utm_campaign=launch&gclid=abc123",
    );
    const t = buildTouch(p, { now: new Date("2026-08-29T00:00:00Z") });
    expect(t).not.toBeNull();
    expect(t!.utm).toEqual({
      utm_source: "twitter",
      utm_medium: "social",
      utm_campaign: "launch",
    });
    expect(t!.click_ids).toEqual({ gclid: "abc123" });
    expect(t!.v).toBe(ATTRIB_VERSION);
    expect(t!.ts).toBe("2026-08-29T00:00:00.000Z");
  });

  it("returns null for an organic direct visit (nothing attributable)", () => {
    expect(buildTouch(new URLSearchParams(""), {})).toBeNull();
    expect(buildTouch(new URLSearchParams("foo=bar"), {})).toBeNull();
  });

  it("keeps an external referrer as a touch", () => {
    const t = buildTouch(new URLSearchParams(""), { referrer: "https://news.ycombinator.com/" });
    expect(t).not.toBeNull();
    expect(t!.referrer).toBe("https://news.ycombinator.com/");
  });

  it("does not create a touch from a same-origin referrer alone", () => {
    const t = buildTouch(new URLSearchParams(""), {
      referrer: "https://financial.nuwrrrld.com/signals",
      selfHost: "financial.nuwrrrld.com",
    });
    expect(t).toBeNull();
  });

  it("truncates over-long values", () => {
    const t = buildTouch(new URLSearchParams(`utm_source=${"x".repeat(500)}`), {});
    expect(t!.utm.utm_source!.length).toBe(256);
  });
});

describe("normaliseReferrer", () => {
  it("drops a same-origin referrer", () => {
    expect(
      normaliseReferrer("https://financial.nuwrrrld.com/signals", "financial.nuwrrrld.com"),
    ).toBeNull();
  });
  it("keeps a cross-origin referrer", () => {
    expect(normaliseReferrer("https://google.com/", "financial.nuwrrrld.com")).toBe(
      "https://google.com/",
    );
  });
  it("drops a non-URL or empty referrer", () => {
    expect(normaliseReferrer("not a url")).toBeNull();
    expect(normaliseReferrer("")).toBeNull();
    expect(normaliseReferrer(null)).toBeNull();
  });
});

describe("serialiseTouch / parseTouch", () => {
  it("round-trips", () => {
    const t = buildTouch(new URLSearchParams("utm_source=reddit"), {})!;
    expect(parseTouch(serialiseTouch(t))).toEqual(t);
  });
  it("rejects a version mismatch", () => {
    expect(parseTouch(JSON.stringify({ v: "9.9", utm: {} }))).toBeNull();
  });
  it("rejects garbage", () => {
    expect(parseTouch("not json")).toBeNull();
    expect(parseTouch(null)).toBeNull();
    expect(parseTouch("")).toBeNull();
  });
});
