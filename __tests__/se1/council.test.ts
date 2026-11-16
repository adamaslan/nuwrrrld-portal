import { describe, expect, it } from "vitest";
import {
  advocateInputs, checkSeatClaim, debateAgenda, replayRecord, sectorInputsGate, sliceForSeat, verdictScorecard,
} from "@/lib/shared/se1/council";
import { card, dossier, EX, GC, row, VOL } from "./fixtures";

describe("C1: each seat receives only its declared role slice; an empty slice abstains", () => {
  const cards = [card(GC, { role: "screen" }), card(EX, { role: "confirm" }), card(VOL, { role: "risk" })];
  const d = dossier([row(GC, true), row(EX, false), row(VOL, true)]);
  it("the bear seat sees risk rows only", () => {
    const r = sliceForSeat(d, ["risk"], cards);
    expect("rows" in r && r.rows.map((x) => x.scan_id)).toEqual([VOL]);
  });
  it("no rows for the role, or no roles at all, abstains", () => {
    expect(sliceForSeat(d, ["value"], cards)).toMatchObject({ abstain: true });
    expect(sliceForSeat(d, [], cards)).toEqual({ abstain: true, reason: "seat declares no roles" });
  });
});

describe("C2: the agenda references actual conflicting rows; no conflict means no debate", () => {
  it("only pairs whose rows are present and flagged become items", () => {
    const d = dossier([row(GC, true), row(EX, true)]);
    expect(debateAgenda({ pairs: [{ a: EX, b: GC }], disqualified: [] }, d).items).toHaveLength(1);
    expect(debateAgenda({ pairs: [{ a: EX, b: GC }], disqualified: [] }, dossier([row(GC, true)])).items).toEqual([]);
  });
  it("an empty report gives an empty agenda with the reason", () => {
    expect(debateAgenda({ pairs: [], disqualified: [] }, dossier([]))).toEqual({ items: [], reason: "no qualifying contradiction between flagged rows" });
  });
});

describe("C3: a fabricated number or wrong unit is rejected even with a valid scan ID", () => {
  const rows = [row(GC, true, "E1", { values: { hit_rate: 0.61 } })];
  it("fabricated figure rejects with a retry", () => {
    expect(checkSeatClaim(`${GC} hit rate was 74%.`, rows, 1, 2)).toMatchObject({ verdict: "reject", retry: true });
  });
  it("wrong unit rejects", () => {
    expect(checkSeatClaim(`${GC} hit rate was 61.`, rows, 1, 2).verdict).toBe("reject");
  });
  it("a grounded claim is accepted; the repair loop is bounded", () => {
    expect(checkSeatClaim(`${GC} hit rate was 61%.`, rows, 1, 2)).toEqual({ verdict: "accept", sentences: [`${GC} hit rate was 61%.`] });
    expect(checkSeatClaim(`${GC} hit rate was 74%.`, rows, 2, 2)).toMatchObject({ verdict: "reject", retry: false });
    expect(checkSeatClaim(`${GC} hit rate was 61%.`, rows, 3, 2).verdict).toBe("abstain");
  });
});

describe("C5: the advocate abstains when no contrary evidence exists", () => {
  const cards = [card(GC, { contradicts: [EX] })];
  it("abstains with the gap", () => {
    expect(advocateInputs(dossier([row(GC, true)]), cards)).toEqual({ abstain: true, reason: "contrary_scans_not_run" });
  });
  it("cites only real contrary rows", () => {
    const r = advocateInputs(dossier([row(GC, true), row(EX, true)]), cards);
    expect("against" in r && r.against.map((x) => x.scan_id)).toEqual([EX]);
  });
});

describe("C6: replay preserves the original verdict and labels today's rerun", () => {
  const original = { verdict: "hold", as_of: "2026-10-01", rows: [{ scan_id: GC, version: "1.0.0" }], models: ["m-a"] };
  const rerun = { verdict: "fold", as_of: "2026-11-08", rows: [{ scan_id: GC, version: "1.1.0" }], models: ["m-b"] };
  it("shows what changed without touching the original", () => {
    const r = replayRecord(original, rerun);
    if (!r.ok) throw new Error(r.error);
    expect(r.original).toEqual(original);
    expect(Object.isFrozen(r.original)).toBe(true);
    expect(r.rerun.label).toMatch(/^Rerun on 2026-11-08/);
    expect(r.changedRows).toEqual([`${GC}@1.0.0`, `${GC}@1.1.0`]);
    expect(r.changedModels).toEqual(["m-a", "m-b"]);
    expect(r.verdictChanged).toBe(true);
  });
});

describe("C7: unmatured outcomes stay pending; denominator and baseline are visible", () => {
  const calls = [
    { id: "a", as_of: "2026-09-01", horizon_days: 20, direction: "up" as const },
    { id: "b", as_of: "2026-09-01", horizon_days: 20, direction: "down" as const },
    { id: "c", as_of: "2026-09-01", horizon_days: 20, direction: "up" as const },
    { id: "d", as_of: "2026-11-01", horizon_days: 20, direction: "up" as const },
  ];
  it("counts", () => {
    expect(verdictScorecard(calls, { a: { return_pct: 3 }, b: { return_pct: 2 } }, "2026-11-08", 0.5))
      .toEqual({ ok: true, hits: 1, n: 2, pending: 1, missing: 1, invalid: 0, hitRate: 0.5, baseline: 0.5 });
  });
  it("no baseline is an error", () => {
    expect(verdictScorecard(calls, {}, "2026-11-08", Number.NaN)).toMatchObject({ ok: false });
  });
});

describe("C8: unavailable sector inputs block affected claims", () => {
  it("missing and stale inputs block only the claims that need them", () => {
    const r = sectorInputsGate(
      [{ id: "rotation", needs: ["sector_returns", "fred_rates"] }, { id: "breadth", needs: ["sector_returns"] }],
      { sector_returns: { as_of: "2026-11-07" }, fred_rates: { as_of: "2026-09-01" } }, "2026-11-08", 7);
    expect(r).toEqual({ allowed: ["breadth"], blocked: [{ claim: "rotation", inputs: [{ name: "fred_rates", reason: "stale" }] }], complete: false });
    expect(sectorInputsGate([{ id: "x", needs: ["absent"] }], {}, "2026-11-08", 7).blocked[0].inputs[0].reason).toBe("missing");
  });
});
