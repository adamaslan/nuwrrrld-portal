import { describe, expect, it } from "vitest";
import {
  briefFreshness, digestKey, digestSendDecision, evidenceMoves, filterQueuedAlerts, flagCrossings, reconcileReminders,
} from "@/lib/shared/se1/monitoring";
import { card, EX, GC, RSI, VOL } from "./fixtures";

describe("D1: retrying the same digest run does not send twice", () => {
  it("first send, then duplicate", () => {
    expect(digestSendDecision("u1", "run-2026-11-08", new Set())).toEqual({ send: true, key: digestKey("u1", "run-2026-11-08") });
    expect(digestSendDecision("u1", "run-2026-11-08", new Set([digestKey("u1", "run-2026-11-08")]))).toEqual({ send: false, reason: "duplicate_run" });
    expect(digestSendDecision("u2", "run-2026-11-08", new Set([digestKey("u1", "run-2026-11-08")])).send).toBe(true);
    expect(digestSendDecision("", "r", new Set())).toEqual({ send: false, reason: "invalid_input" });
  });
});

describe("D2: repeated flag rows give one crossing, not one per poll", () => {
  it("false→true once; repeated true and unknown rows never re-fire", () => {
    expect(flagCrossings([
      { as_of: "2026-11-01", flag: false }, { as_of: "2026-11-02", flag: true }, { as_of: "2026-11-03", flag: true },
      { as_of: "2026-11-04", flag: null }, { as_of: "2026-11-05", flag: true }, { as_of: "2026-11-06", flag: false },
      { as_of: "2026-11-07", flag: true },
    ])).toEqual(["2026-11-02", "2026-11-07"]);
  });
  it("order of input does not matter; a first-ever true is not a crossing", () => {
    expect(flagCrossings([{ as_of: "2026-11-02", flag: true }, { as_of: "2026-11-01", flag: false }])).toEqual(["2026-11-02"]);
    expect(flagCrossings([{ as_of: "2026-11-01", flag: true }])).toEqual([]);
  });
});

describe("D3: a holdings change invalidates queued alerts for positions no longer owned", () => {
  it("drops sold positions", () => {
    const r = filterQueuedAlerts([{ id: "1", ticker: "AAPL" }, { id: "2", ticker: "TSLA" }], ["aapl"]);
    expect(r.keep.map((a) => a.id)).toEqual(["1"]);
    expect(r.dropped).toEqual([{ alert: { id: "2", ticker: "TSLA" }, reason: "no_longer_held" }]);
  });
});

describe("D5: rescheduled earnings remove the old reminder and keep one consented replacement", () => {
  it("moved event: remove old, add new", () => {
    expect(reconcileReminders([{ ticker: "AAPL", event_date: "2026-11-20" }], [{ ticker: "AAPL", date: "2026-11-27", status: "scheduled" }], true))
      .toEqual({ keep: [], remove: [{ ticker: "AAPL", event_date: "2026-11-20" }], add: [{ ticker: "AAPL", event_date: "2026-11-27" }] });
  });
  it("duplicates collapse to one; cancelled or no consent keeps none", () => {
    const dup = [{ ticker: "AAPL", event_date: "2026-11-27" }, { ticker: "AAPL", event_date: "2026-11-27" }];
    const r = reconcileReminders(dup, [{ ticker: "AAPL", date: "2026-11-27", status: "scheduled" }], true);
    expect([r.keep.length, r.remove.length, r.add.length]).toEqual([1, 1, 0]);
    expect(reconcileReminders(dup, [{ ticker: "AAPL", date: "2026-11-27", status: "cancelled" }], true).keep).toEqual([]);
    expect(reconcileReminders(dup, [{ ticker: "AAPL", date: "2026-11-27", status: "scheduled" }], false)).toMatchObject({ keep: [], add: [] });
  });
});

describe("D7: demotions and invalidations are corrections, listed before promotions", () => {
  it("corrections first", () => {
    const prev = [card(GC, { evidence_level: "E1" }), card(EX, { evidence_level: "E3" }), card(RSI, { evidence_level: "E2" }), card(VOL, { evidence_level: "E2" })];
    const curr = [card(GC, { evidence_level: "E2" }), card(EX, { evidence_level: "E1" }), card(RSI, { status: "retired", evidence_level: "E2" }),
      card(VOL, { version: "2.0.0", evidence_level: "E0" })];
    const moves = evidenceMoves(prev, curr);
    expect(moves.map((m) => [m.id, m.kind, m.correction])).toEqual([
      [RSI, "retired", true], [VOL, "new_version", true], [EX, "demotion", true], [GC, "promotion", false],
    ]);
  });
});

describe("D8: a failed morning run shows its real freshness", () => {
  const tz = "America/New_York";
  it("built today and the run succeeded: current", () => {
    expect(briefFreshness("2026-11-08T11:30:00Z", new Date("2026-11-08T14:00:00Z"), false, tz).state).toBe("current");
  });
  it("today's run failed: stale with the real timestamp, never 'today'", () => {
    const r = briefFreshness("2026-11-07T11:30:00Z", new Date("2026-11-08T14:00:00Z"), true, tz);
    expect(r).toEqual({ state: "stale", label: "Stale: last built 2026-11-07T11:30:00Z (today's run failed).", built_at: "2026-11-07T11:30:00Z" });
  });
  it("yesterday local time is stale even when the UTC date matches", () => {
    expect(briefFreshness("2026-11-08T03:00:00Z", new Date("2026-11-08T14:00:00Z"), false, tz).state).toBe("stale");
  });
  it("no brief or an unparseable timestamp is unavailable", () => {
    expect(briefFreshness(null, new Date(), false, tz).state).toBe("unavailable");
    expect(briefFreshness("this morning", new Date(), false, tz).state).toBe("unavailable");
  });
});
