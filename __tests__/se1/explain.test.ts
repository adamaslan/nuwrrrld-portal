import { describe, expect, it } from "vitest";
import { glossaryEntryCheck, hitRateChartData, howWeKnow } from "@/lib/shared/se1/explain";
import { card, EX, GC, row } from "./fixtures";

describe("G3: the drawer shows exact source/version/cutoff and unavailable fields, nothing private", () => {
  it("a sourced row shows its provenance and no values", () => {
    const r = howWeKnow(row(GC, true, "E1", { values: { position_value: 125000 } }));
    expect(r).toEqual({ scan_id: GC, source: "se1 fixture", feed: "alpaca_bars", as_of: "2026-11-08", scan_version: "1.0.0", evidence_level: "E1" });
    expect(Object.keys(r).sort()).toEqual(["as_of", "evidence_level", "feed", "scan_id", "scan_version", "source"]);
  });
  it("missing and invalid fields say unavailable", () => {
    expect(howWeKnow(row(GC, true, "E1", { provenance: { source: " ", as_of: "not-a-date" } })))
      .toMatchObject({ source: "unavailable", feed: "unavailable", as_of: "unavailable", scan_version: "unavailable" });
  });
});

describe("G4: insufficient samples or no baseline prevent a chart; n and uncertainty are always shown", () => {
  it("unavailable cases", () => {
    expect(hitRateChartData(10, 20, 0.5)).toEqual({ available: false, reason: "only 20 samples, needs 30" });
    expect(hitRateChartData(30, 50, null)).toEqual({ available: false, reason: "no baseline" });
    expect(hitRateChartData(60, 50, 0.5)).toEqual({ available: false, reason: "invalid counts" });
  });
  it("available case carries n and a 95% interval around the rate", () => {
    const r = hitRateChartData(30, 50, 0.5);
    expect(r).toMatchObject({ available: true, rate: 0.6, n: 50, baseline: 0.5 });
    if (r.available) { expect(r.interval[0]).toBeLessThan(0.6); expect(r.interval[1]).toBeGreaterThan(0.6); expect(r.interval[0]).toBeCloseTo(0.4617, 3); }
  });
});

describe("G8: glossary prose cannot add unsupported claims; it is bounded and versioned", () => {
  const c = card(GC, { version: "1.2.0", prose: "Flags a 50-day average crossing above the 200-day average.", contradicts: [EX] });
  it("an entry using only the card's figures and references passes, keyed by version", () => {
    expect(glossaryEntryCheck({ card_id: GC, card_version: "1.2.0", text: `When the 50-day average crosses the 200-day one. Compare ${EX}.` }, c))
      .toEqual({ ok: true, key: `${GC}@1.2.0` });
  });
  it("an invented figure, a foreign scan ID, a stale version or an overlong entry fails", () => {
    const r = glossaryEntryCheck({ card_id: GC, card_version: "1.1.0", text: `It wins 73% of the time, unlike se1.mom.rsi_oversold.` }, c);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("|")).toMatch(/version.*figure (0\.)?73\b.*se1\.mom\.rsi_oversold/);
    expect(glossaryEntryCheck({ card_id: GC, card_version: "1.2.0", text: "x".repeat(401) }, c).ok).toBe(false);
  });
});
