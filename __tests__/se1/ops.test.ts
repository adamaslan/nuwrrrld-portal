import { describe, expect, it } from "vitest";
import {
  abAssignment, applyFeedback, assessDuplicates, checkIncidentNote, driftDecision, nextEvidenceState, pruneProposals,
  telemetryEvent, withFallback, type EvidenceEntry,
} from "@/lib/shared/se1/ops";

describe("J1: a new version starts at E0; demotion propagates; history stays available", () => {
  it("append-only lifecycle", () => {
    let h: EvidenceEntry[] = [];
    const step = (e: Parameters<typeof nextEvidenceState>[1]) => {
      const r = nextEvidenceState(h, e);
      if (!r.ok) throw new Error(r.error);
      h = r.history;
      return r.current;
    };
    step({ type: "new_version", version: "1", at: "2026-01-01" });
    expect(step({ type: "promote", level: "E3", at: "2026-03-01" }).level).toBe("E3");
    expect(step({ type: "new_version", version: "2", at: "2026-04-01" }).level).toBe("E0");
    step({ type: "promote", level: "E2", at: "2026-05-01" });
    expect(step({ type: "invalidate", at: "2026-06-01", reason: "data error" })).toMatchObject({ level: "E0", event: "invalidate" });
    expect(h.map((e) => `${e.version}:${e.level}`)).toEqual(["1:E0", "1:E3", "2:E0", "2:E2", "2:E0"]);
  });
  it("rejects promotions that do not raise, events out of order, and work before a version exists", () => {
    const base = [{ version: "1", level: "E2" as const, at: "2026-02-01", event: "promote" }];
    expect(nextEvidenceState(base, { type: "promote", level: "E1", at: "2026-03-01" }).ok).toBe(false);
    expect(nextEvidenceState(base, { type: "invalidate", at: "2026-01-01", reason: "x" }).ok).toBe(false);
    expect(nextEvidenceState([], { type: "promote", level: "E1", at: "2026-03-01" }).ok).toBe(false);
  });
});

describe("J3: assignment is stable and budgeted; fallbacks are logged", () => {
  const arms = [{ name: "control", model: "m-a", version: "1" }, { name: "test", model: "m-b", version: "2" }];
  it("same key, same arm; over budget, control", () => {
    const a = abAssignment("req-123", arms, 1, 10);
    expect(abAssignment("req-123", arms, 5, 10)).toEqual(a);
    expect(abAssignment("req-123", arms, 10, 10)).toMatchObject({ arm: "control", reason: "over_budget" });
    const keys = Array.from({ length: 200 }, (_, i) => abAssignment(`k${i}`, arms, 0, 10));
    expect(new Set(keys.map((k) => ("arm" in k ? k.arm : "")))).toEqual(new Set(["control", "test"]));
  });
  it("a fallback model is recorded", () => {
    const a = abAssignment("req-1", arms, 0, 10);
    if ("error" in a) throw new Error(a.error);
    expect(withFallback(a, "m-z").fallback).toBe("m-z");
    expect(withFallback(a, a.model).fallback).toBeNull();
  });
});

describe("J4: small samples and outages are not drift; alerts are deduplicated", () => {
  const base = { minN: 100, inputOutage: false, alreadyAlerted: new Set<string>() };
  it("cases", () => {
    expect(driftDecision("s", "2026-W45", { flagged: 2, n: 10 }, { flagged: 9, n: 10 }, base)).toEqual({ alert: false, reason: "insufficient_sample" });
    expect(driftDecision("s", "2026-W45", { flagged: 100, n: 1000 }, { flagged: 400, n: 1000 }, { ...base, inputOutage: true })).toEqual({ alert: false, reason: "input_outage" });
    const d = driftDecision("s", "2026-W45", { flagged: 100, n: 1000 }, { flagged: 400, n: 1000 }, base);
    expect(d).toMatchObject({ alert: true, key: "s|2026-W45|up" });
    expect(driftDecision("s", "2026-W45", { flagged: 100, n: 1000 }, { flagged: 400, n: 1000 }, { ...base, alreadyAlerted: new Set(["s|2026-W45|up"]) }).alert).toBe(false);
    expect(driftDecision("s", "2026-W45", { flagged: 100, n: 1000 }, { flagged: 105, n: 1000 }, base)).toMatchObject({ alert: false, reason: "no_drift" });
  });
});

describe("J5: short, flat or mismatched series are unassessable; nothing is auto-deleted (audit R8)", () => {
  it("every unassessable pair has a reason", () => {
    const up = [1, 2, 3, 4, 5, 6];
    const r = assessDuplicates({ a: up, b: up.map((x) => x * 2 + 1), flat: [1, 1, 1, 1, 1, 1], short: [1, 2], nan: [1, 2, Number.NaN, 4, 5, 6] });
    expect(r.pairs).toEqual([{ a: "a", b: "b", r: 1, action: "review_merge" }]);
    const reason = (x: string, y: string) => r.unassessable.find((u) => u.a === x && u.b === y)?.reason;
    expect(reason("a", "flat")).toBe("flat");
    expect(reason("a", "short")).toBe("length_mismatch");
    expect(reason("a", "nan")).toBe("non_finite");
    expect(assessDuplicates({ x: [1, 2], y: [2, 3] }).unassessable).toEqual([{ a: "x", b: "y", reason: "too_short" }]);
  });
});

describe("J6: telemetry redacts private content; low counts only propose review", () => {
  it("drops every field but recipe, surface and day", () => {
    expect(telemetryEvent({ recipe_id: "momentum-entry", surface: "web", at: "2026-11-08T23:30:00Z", user_email: "x@y.z", holdings: ["AAPL"] }))
      .toEqual({ recipe_id: "momentum-entry", surface: "web", day: "2026-11-08" });
    expect(telemetryEvent({ recipe_id: "a b", surface: "web", at: "2026-11-08T00:00:00Z" })).toBeNull();
    expect(telemetryEvent({ recipe_id: "r", surface: "desktop", at: "2026-11-08T00:00:00Z" })).toBeNull();
  });
  it("pruning proposes, never removes", () => {
    expect(pruneProposals({ a: 0, b: 50, c: 2 }, 5)).toEqual([{ recipe_id: "a", count: 0, action: "review" }, { recipe_id: "c", count: 2, action: "review" }]);
  });
});

describe("J7: duplicate or abusive feedback is bounded and cannot promote evidence", () => {
  it("one vote per user per finding; daily cap per user", () => {
    const v = (user: string, finding: string, vote: 1 | -1, at: string) => ({ user, finding, vote, day: at.slice(0, 10), at });
    const r = applyFeedback([
      v("u1", "f1", 1, "2026-11-08T01:00:00Z"), v("u1", "f1", 1, "2026-11-08T02:00:00Z"), v("u1", "f1", -1, "2026-11-08T03:00:00Z"),
      v("u2", "f1", 1, "2026-11-08T01:00:00Z"),
      v("u3", "f2", 1, "2026-11-08T01:00:00Z"), v("u3", "f3", 1, "2026-11-08T02:00:00Z"), v("u3", "f4", 1, "2026-11-08T03:00:00Z"),
    ], 2);
    expect(r).toEqual({ f1: 0, f2: 1, f3: 1 });
    expect(JSON.stringify(r)).not.toMatch(/E[0-4]/);
  });
});

describe("J8: incident notes cite actual logs/run IDs and never invent causes or publish secrets", () => {
  const run = { ids: ["run-8812"], log_lines: ["ERROR alpaca bars request returned 429 Too Many Requests"] };
  it("a cause with evidence stays; an invented cause becomes 'Cause unknown.'", () => {
    const r = checkIncidentNote("The nightly run degraded. It failed because of a cosmic ray. Run run-8812 failed due to rate limiting.", run);
    expect(r.text).toBe("The nightly run degraded. Cause unknown. Run run-8812 failed due to rate limiting.");
    expect(r.unsupportedCauses).toEqual(["It failed because of a cosmic ray."]);
  });
  it("secret-shaped strings are redacted", () => {
    // Fake secret shapes, assembled at runtime so no key-shaped literal sits in the source.
    const fakeOpenAi = ["sk", "abcdefghijklmnop1234"].join("-");
    const fakeAws = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    const fakeDb = ["postgres", "//u", "p@h/db"].join(":");
    const r = checkIncidentNote(`Token ${fakeOpenAi} and ${fakeAws} leaked. DB ${fakeDb}.`, run);
    expect(r.redacted).toBe(3);
    expect(r.text).not.toMatch(/sk-|AKIA|postgres:/);
  });
});
