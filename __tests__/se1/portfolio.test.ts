import { describe, expect, it } from "vitest";
import {
  alignedCorrelation, exposureCalendar, fundamentalsDrift, healthCacheKey, healthClaimsGate, ownershipLine,
  rebalanceCandidates, regimeFit, valueAsOf, type DatedValue,
} from "@/lib/shared/se1/portfolio";
import { GC, row } from "./fixtures";

const series = (n: number, f: (i: number) => number, offset = 0): DatedValue[] =>
  Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i + offset)).toISOString().slice(0, 10), value: f(i) }));

describe("E2: unaligned or short overlaps return insufficient data, not zero correlation", () => {
  it("aligned series correlate", () => {
    expect(alignedCorrelation(series(30, (i) => i + Math.sin(i)), series(30, (i) => 2 * i + Math.sin(i)), 20)).toMatchObject({ status: "ok", n: 30 });
  });
  it("too few shared dates is insufficient", () => {
    expect(alignedCorrelation(series(30, (i) => i), series(30, (i) => i, 25), 20)).toEqual({ status: "insufficient_data", reason: "only 5 shared dates, needs 20", n: 5 });
  });
  it("a flat series is insufficient, never r = 0", () => {
    expect(alignedCorrelation(series(30, (i) => i), series(30, () => 5), 20).status).toBe("insufficient_data");
  });
});

describe("E4: candidates require review; no order path; incomplete holdings are disclosed", () => {
  it("items have no side, quantity or order fields", () => {
    const r = rebalanceCandidates([{ ticker: "NVDA", weight: 0.31 }, { ticker: "AAPL", weight: 0.1 }], 0.2, { covered: 8, total: 10 });
    expect(r.items).toEqual([{ ticker: "NVDA", status: "needs_review", reason: "weight 31% is above the 20% cap" }]);
    expect(JSON.stringify(r.items)).not.toMatch(/side|qty|quantity|order/i);
    expect(r.disclosure).toBe("Only 8 of 10 holdings could be assessed. Candidates may be missing.");
  });
});

describe("E5: unsupported health claims are rejected; the cache is per user", () => {
  it("only grounded sentences are publishable", () => {
    const r = healthClaimsGate(`${GC} flagged. Your portfolio will outperform by 40%.`, [row(GC, true)]);
    expect(r.publishable).toEqual([`${GC} flagged.`]);
    expect(r.rejected).toHaveLength(1);
  });
  it("cache keys require the user and the holdings hash", () => {
    expect(healthCacheKey("u1", "h1")).not.toBe(healthCacheKey("u2", "h1"));
    expect(() => healthCacheKey("", "h1")).toThrow();
  });
});

describe("E6: missing regime or holdings snapshots yield unknown fit, never a default label", () => {
  const holdings = { as_of: "2026-11-07", positions: [{ ticker: "NVDA", weight: 0.5, beta: 1.8 }, { ticker: "KO", weight: 0.5, beta: 0.6 }] };
  it.each([
    [null, { as_of: "2026-11-07", regime: "risk_on" as const }],
    [holdings, null],
    [holdings, { as_of: "2026-11-07", regime: null }],
    [holdings, { as_of: "2026-09-01", regime: "risk_on" as const }],
    [{ ...holdings, positions: [{ ticker: "NVDA", weight: 1, beta: null }] }, { as_of: "2026-11-07", regime: "risk_on" as const }],
  ])("unknown: %#", (h, r) => {
    expect(regimeFit(h, r, "2026-11-08", 5).fit).toBe("unknown");
  });
  it("a complete, fresh pair gives a label", () => {
    expect(regimeFit({ as_of: "2026-11-07", positions: [{ ticker: "NVDA", weight: 1, beta: 1.8 }] }, { as_of: "2026-11-07", regime: "risk_off" }, "2026-11-08", 5))
      .toEqual({ fit: "misaligned", weighted_beta: 1.8 });
  });
});

describe("E7: time zones and rescheduled events keep exposure dates and totals correct", () => {
  it("an after-close UTC timestamp lands on the exchange-local day; the latest reschedule wins; days sum to the week", () => {
    const r = exposureCalendar(
      [{ ticker: "AAPL", value: 1000 }, { ticker: "MSFT", value: 500 }, { ticker: "TSLA", value: 200 }],
      [
        { ticker: "AAPL", at: "2026-11-11T01:30:00Z", status: "scheduled", updated_at: "2026-11-01T00:00:00Z" },
        { ticker: "MSFT", at: "2026-11-12T21:00:00Z", status: "scheduled", updated_at: "2026-11-01T00:00:00Z" },
        { ticker: "MSFT", at: "2026-11-13T21:00:00Z", status: "scheduled", updated_at: "2026-11-05T00:00:00Z" },
        { ticker: "TSLA", at: "2026-11-12T21:00:00Z", status: "cancelled", updated_at: "2026-11-05T00:00:00Z" },
      ], "2026-11-09");
    if (!r.ok) throw new Error(r.error);
    expect(r.days["2026-11-10"]).toEqual({ tickers: ["AAPL"], total: 1000 });
    expect(r.days["2026-11-13"]).toEqual({ tickers: ["MSFT"], total: 500 });
    expect(r.days["2026-11-12"].total).toBe(0);
    expect(r.weekTotal).toBe(1500);
  });
});

describe("E8: amended filings keep the original vintage; drift uses what was known at each date", () => {
  const filings = [
    { period_end: "2026-06-30", filed_at: "2026-08-01", value: 100 },
    { period_end: "2026-06-30", filed_at: "2026-10-15", value: 90 },
    { period_end: "2026-09-30", filed_at: "2026-11-01", value: 110 },
  ];
  it("before the amendment the original value is what was known", () => {
    expect(valueAsOf(filings, "2026-09-01")?.value).toBe(100);
    expect(valueAsOf(filings, "2026-10-20")?.value).toBe(90);
    expect(valueAsOf(filings, "2026-11-02")?.value).toBe(110);
    expect(valueAsOf(filings, "2026-07-01")).toBeNull();
  });
  it("drift compares point-in-time values", () => {
    expect(fundamentalsDrift(filings, "2026-09-01", "2026-11-02")).toMatchObject({ available: true, change: 10 });
  });
});

describe("E9: ownership is reported with its filing lag, never as live", () => {
  it("names the period, the filing date and the lag", () => {
    const r = ownershipLine({ holder: "Fund\nX", shares: 1200, period_end: "2026-09-30", filed_at: "2026-11-14" });
    expect(r).toMatchObject({ available: true, lag_days: 45 });
    if (r.available) expect(r.text).toBe("Fund X reported 1,200 shares as of 2026-09-30, filed 2026-11-14 (45 days later). This is as of the filing, not current ownership.");
  });
  it("undated or impossible filings are unavailable", () => {
    expect(ownershipLine({ holder: "X", shares: 1, period_end: "", filed_at: "2026-11-14" }).available).toBe(false);
    expect(ownershipLine({ holder: "X", shares: 1, period_end: "2026-11-30", filed_at: "2026-11-14" }).available).toBe(false);
  });
});
