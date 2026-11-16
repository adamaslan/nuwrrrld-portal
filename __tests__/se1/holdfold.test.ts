import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  arbitrationInputs, backtestEntries, familyAccuracy, foldReasons, holdFoldAnswer, holdFoldEvidence, postMortemStats, tagPaperEntry,
} from "@/lib/shared/se1/holdfold";
import { dossier, EX, GC, row, VOL } from "./fixtures";

describe("F2: mixed or invalid evidence cannot inflate the call (audit R7)", () => {
  it("one E4 among nine E0 is E0 and says the evidence is mixed", () => {
    const r = holdFoldEvidence([{ flag: true, evidence_level: "E4" }, ...Array.from({ length: 9 }, () => ({ flag: true, evidence_level: "E0" as const }))]);
    expect(r).toMatchObject({ ok: true, level: "E0", mixed: true, flagged: 10 });
    if (r.ok) expect(r.text).toBe("Evidence is mixed: 1 of 10 backing scans is E4, 9 are E0.");
  });
  it("the level is the highest one at least half the flagged rows reach", () => {
    const r = holdFoldEvidence([{ flag: true, evidence_level: "E3" }, { flag: true, evidence_level: "E3" }, { flag: true, evidence_level: "E1" }, { flag: false, evidence_level: "E4" }]);
    expect(r).toMatchObject({ ok: true, level: "E3", mixed: true });
  });
  it("an unknown level is an error; there is never a percentage or the word confidence", () => {
    expect(holdFoldEvidence([{ flag: true, evidence_level: "E9" as never }])).toEqual({ ok: false, error: 'unknown evidence level "E9"' });
    const r = holdFoldEvidence([{ flag: true, evidence_level: "E2" }]);
    expect(JSON.stringify(r)).not.toMatch(/%|confiden/i);
  });
});

describe("F3: a paper entry keeps immutable recipe identity", () => {
  it("changing the recipe later does not change the tag", () => {
    const recipe = { id: "momentum-entry", version: "1" };
    const tagged = tagPaperEntry({ id: "p1", ticker: "AAPL", opened_at: "2026-11-08" }, recipe, "abc123");
    recipe.version = "2";
    expect(tagged.recipe_version).toBe("1");
    expect(Object.isFrozen(tagged)).toBe(true);
    expect(() => tagPaperEntry({ id: "p1", ticker: "AAPL", opened_at: "" }, { id: "r", version: "" }, "h")).toThrow();
  });
});

describe("F4: malformed or absent rows make arbitration abstain; no order path exists", () => {
  it("abstains", () => {
    expect(arbitrationInputs(null)).toMatchObject({ abstain: true });
    expect(arbitrationInputs([])).toEqual({ abstain: true, reason: "no se1 rows" });
    expect(arbitrationInputs([row(GC, true), { scan_id: GC, flag: "yes" }])).toEqual({ abstain: true, reason: "row 1 is malformed" });
    expect(arbitrationInputs([row(GC, true)])).toMatchObject({ rows: [{ scan_id: GC }] });
  });
  it("the module imports nothing that can place an order", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/shared/se1/holdfold.ts"), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
    expect(imports).not.toMatch(/alpaca|broker|order|trade|fetch|api\//i);
    expect(src).not.toMatch(/api\.alpaca\.markets|\/v2\/orders/);
  });
});

describe("F5: post-mortems include losses and costs; missing outcomes are not successes", () => {
  it("counts", () => {
    expect(postMortemStats([{ id: "a", pnl: 50, costs: 5 }, { id: "b", pnl: 3, costs: 5 }, { id: "c", pnl: null, costs: 5 }, { id: "d", pnl: -20, costs: 1 }]))
      .toEqual({ wins: 1, losses: 2, unknown: 1, net: 22, winRate: 1 / 3 });
  });
});

describe("F6: missing Trim-gate members give an incomplete gate, not a Fold reason", () => {
  it("incomplete, then complete", () => {
    expect(foldReasons([VOL, EX], [row(VOL, true)])).toEqual({ complete: false, missing: [EX] });
    expect(foldReasons([VOL, EX], [row(VOL, true), row(EX, false)])).toMatchObject({ complete: true, reasons: [{ scan_id: VOL }] });
    expect(foldReasons([], [])).toMatchObject({ complete: false });
  });
});

describe("F7: future rows cannot change prior entries; costs and windows are explicit", () => {
  const rows = [
    { date: "2026-01-02", flag: false }, { date: "2026-01-05", flag: true }, { date: "2026-01-06", flag: true },
    { date: "2026-03-02", flag: false }, { date: "2026-03-03", flag: true }, { date: "2026-06-01", flag: false }, { date: "2026-06-02", flag: true },
  ];
  const costs = { fee_bps: 1, slippage_bps: 4 };
  const windows = { train_end: "2026-02-28", eval_start: "2026-05-01" };
  it("a prefix of the rows gives a prefix of the entries", () => {
    const all = backtestEntries(rows, costs, windows);
    for (let n = 1; n <= rows.length; n++) {
      const part = backtestEntries(rows.slice(0, n), costs, windows);
      expect(all.slice(0, part.length)).toEqual(part);
    }
    expect(all.map((e) => e.window)).toEqual(["train", "gap", "evaluation"]);
    expect(all.every((e) => e.cost_bps === 5)).toBe(true);
  });
  it("costs are required and windows must not overlap", () => {
    expect(() => backtestEntries(rows, undefined as never, windows)).toThrow(/fee_bps/);
    expect(() => backtestEntries(rows, { fee_bps: Number.NaN, slippage_bps: 0 }, windows)).toThrow();
    expect(() => backtestEntries(rows, costs, { train_end: "2026-05-01", eval_start: "2026-02-28" })).toThrow(/eval_start/);
  });
});

describe("F8: pending and overlapping outcomes do not inflate accuracy", () => {
  it("denominators reconcile", () => {
    const r = familyAccuracy([
      { family: "trend", call_date: "2026-01-01", horizon_days: 20, status: "hit" },
      { family: "trend", call_date: "2026-01-10", horizon_days: 20, status: "hit" },
      { family: "trend", call_date: "2026-02-01", horizon_days: 20, status: "miss" },
      { family: "trend", call_date: "2026-03-01", horizon_days: 20, status: "pending" },
    ]);
    expect(r.trend).toEqual({ hits: 1, n: 2, pending: 1, overlapping: 1, accuracy: 0.5 });
  });
});

describe("F9: unsupported tickers or missing results abstain with the gaps", () => {
  const supported = new Set(["AAPL"]);
  it.each([
    ["DOGE", dossier([row(GC, true)])],
    ["AAPL", null],
    ["AAPL", dossier([], [{ scan_id: GC, reason: "feed not built" }])],
  ] as const)("abstains: %s %#", (t, d) => {
    expect(holdFoldAnswer(t, d, supported).kind).toBe("abstain");
  });
  it("gaps name the missing scans", () => {
    expect(holdFoldAnswer("AAPL", dossier([], [{ scan_id: GC, reason: "feed not built" }]), supported))
      .toEqual({ kind: "abstain", gaps: ["no scans were run", `${GC}: feed not built`] });
  });
  it("answers only with real rows and an evidence level", () => {
    expect(holdFoldAnswer(" aapl ", dossier([row(GC, true, "E2")]), supported)).toMatchObject({ kind: "evidence", ticker: "AAPL", evidence: { level: "E2" } });
  });
});
