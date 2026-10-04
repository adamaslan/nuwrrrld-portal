/**
 * followed-tickers horizon exits (plan F5, L1). A fixed horizon must exit on
 * its own trading-day offset, never on the latest close. A missing due close
 * voids the horizon rather than borrowing a later one.
 */
import { describe, expect, it } from "vitest";
import { horizonExit } from "@/lib/shared/followed-tickers-policy";

/** Entry on Monday 2026-06-01. */
const ENTRY = new Date("2026-06-01T14:00:00Z");

/** Weekday ISO dates strictly after ENTRY, in order, `count` of them. */
function weekdaysAfterEntry(count: number): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(2026, 5, 1));
  while (out.length < count) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cur.toISOString().slice(0, 10));
  }
  return out;
}

const obs = (dates: string[]) => dates.map((observedOn) => ({ observedOn, closePrice: 100 }));

describe("horizonExit", () => {
  it("exits on the exact trading-day offset", () => {
    const series = obs(weekdaysAfterEntry(10));
    const result = horizonExit(series, ENTRY, "w1");
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") expect(result.observation.observedOn).toBe("2026-06-08");
  });

  it("is pending while no observation has reached the offset", () => {
    const series = obs(weekdaysAfterEntry(3));
    expect(horizonExit(series, ENTRY, "w1").kind).toBe("pending");
  });

  it("is pending with no observations at all", () => {
    expect(horizonExit([], ENTRY, "d1").kind).toBe("pending");
  });

  it("never uses a later close when the due observation is missing by more than the lag", () => {
    // w1 is 5 trading days. Remove day 5 and day 6, so the first observation past
    // the offset sits 2 trading days late. Scoring it would borrow a later close.
    const days = weekdaysAfterEntry(8);
    const series = obs(days.filter((_, i) => i !== 4 && i !== 5));
    expect(horizonExit(series, ENTRY, "w1").kind).toBe("void");
  });

  it("tolerates one trading day of lag, which covers a single market holiday", () => {
    // Day 5 has no observation (a holiday), so the exit falls to day 6.
    const days = weekdaysAfterEntry(8);
    const series = obs(days.filter((_, i) => i !== 4));
    const result = horizonExit(series, ENTRY, "w1");
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") expect(result.observation.observedOn).toBe("2026-06-09");
  });

  it("resolves d1 on the next trading day", () => {
    const series = obs(weekdaysAfterEntry(2));
    const result = horizonExit(series, ENTRY, "d1");
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") expect(result.observation.observedOn).toBe("2026-06-02");
  });
});
