import { describe, expect, it } from "vitest";
import {
  deepDiveSections, dipCheckVerdict, freezeSnapshot, momentumEntryDossier, preEarningsValidity, publicDossierView,
  qualityValueRatios, safeRatio, thesisBreak, type Bar,
} from "@/lib/shared/se1/dossiers";
import { dossier, EX, GC, row, RSI } from "./fixtures";

function bars(n: number, start = 100, step = 0.5): Bar[] {
  const t0 = Date.UTC(2025, 0, 1);
  return Array.from({ length: n }, (_, i) => ({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), close: start + i * step }));
}

describe("B1: a mixed dossier labels unavailable sections and never claims full coverage", () => {
  it("complete, partial and unavailable sections are distinct; coverage is partial", () => {
    const d = dossier([row(GC, true), row(EX, false)], [{ scan_id: RSI, reason: "feed not built" }]);
    const r = deepDiveSections(d, [
      { name: "trend", scans: [GC, EX] }, { name: "momentum", scans: [GC, RSI] }, { name: "risk", scans: ["se1.risk.drawdown_depth"] },
    ]);
    expect(r.sections.map((s) => s.status)).toEqual(["complete", "partial", "unavailable"]);
    expect(r.sections[1].absent).toEqual([{ scan_id: RSI, reason: "feed not built" }]);
    expect(r.coverage).toBe("partial");
  });
  it("full only when every section is complete", () => {
    expect(deepDiveSections(dossier([row(GC, true)]), [{ name: "t", scans: [GC] }]).coverage).toBe("full");
    expect(deepDiveSections(dossier([]), []).coverage).toBe("none");
  });
});

describe("B2: short history is missing; fixed valid input reproduces the same findings", () => {
  it("fewer than 200 bars is missing", () => {
    expect(momentumEntryDossier(bars(199))).toEqual({ status: "missing", reason: "needs 200 daily bars, has 199" });
  });
  it("unordered or invalid bars are missing", () => {
    const b = bars(220); b[5] = { ...b[5], date: b[3].date };
    expect(momentumEntryDossier(b).status).toBe("missing");
    const c = bars(220); c[10] = { ...c[10], close: Number.NaN };
    expect(momentumEntryDossier(c).status).toBe("missing");
  });
  it("same bars, same findings", () => {
    const b = bars(260);
    const r = momentumEntryDossier(b);
    expect(r).toEqual(momentumEntryDossier(b.map((x) => ({ ...x }))));
    expect(r).toMatchObject({ status: "ok", as_of: b[259].date, findings: { sma50_above_sma200: true } });
  });
});

describe("B3: a changed or cancelled earnings date invalidates the dossier timing", () => {
  const built = { ticker: "AAPL", event_date: "2026-11-20" };
  it.each([
    [{ ticker: "AAPL", date: "2026-11-20", status: "scheduled" as const }, true],
    [{ ticker: "AAPL", date: "2026-11-27", status: "scheduled" as const }, false],
    [{ ticker: "AAPL", date: "2026-11-20", status: "cancelled" as const }, false],
    [null, false],
  ])("%#", (event, valid) => {
    expect(preEarningsValidity(built, event).valid).toBe(valid);
  });
  it("a move says from and to", () => {
    expect(preEarningsValidity(built, { ticker: "AAPL", date: "2026-11-27", status: "scheduled" }))
      .toEqual({ valid: false, reason: "earnings moved from 2026-11-20 to 2026-11-27" });
  });
});

describe("B4: missing fundamentals prevent a conclusion despite positive price signals", () => {
  const allUp = [{ flag: true }, { flag: true }, { flag: true }];
  it("null or partial fundamentals are inconclusive", () => {
    expect(dipCheckVerdict(allUp, null, ["pe", "fcf_margin"])).toMatchObject({ verdict: "inconclusive", missing: ["pe", "fcf_margin"] });
    expect(dipCheckVerdict(allUp, { pe: 14, fcf_margin: null }, ["pe", "fcf_margin"])).toMatchObject({ verdict: "inconclusive", missing: ["fcf_margin"] });
    expect(dipCheckVerdict(allUp, { pe: Number.NaN, fcf_margin: 0.2 }, ["pe", "fcf_margin"]).verdict).toBe("inconclusive");
  });
  it("with every fundamental present it is a review candidate, never 'buy'", () => {
    const r = dipCheckVerdict(allUp, { pe: 14, fcf_margin: 0.2 }, ["pe", "fcf_margin"]);
    expect(r.verdict).toBe("review_candidate");
    expect(JSON.stringify(r)).not.toMatch(/buy/i);
  });
});

describe("B5: compare to a frozen snapshot, never to silently replaced history", () => {
  const snap = freezeSnapshot("thesis-1", dossier([row(GC, true)]));
  it("a change against the snapshot is reported", () => {
    expect(thesisBreak(snap, dossier([row(GC, false)]))).toMatchObject({ ok: true, changed: true, flipped: [GC], snapshot_id: "thesis-1" });
  });
  it("an altered snapshot is an error", () => {
    const tampered = { ...snap, dossier: dossier([row(GC, false)]) };
    expect(thesisBreak(tampered, dossier([row(GC, false)]))).toEqual({ ok: false, error: "snapshot content does not match its hash" });
  });
  it("a snapshot with no id is an error; the frozen copy is detached from the source", () => {
    expect(thesisBreak({ ...snap, id: "" }, dossier([]))).toEqual({ ok: false, error: "snapshot has no id" });
    const src = dossier([row(GC, true)]);
    const s = freezeSnapshot("t", src);
    src.rows[0].flag = false;
    expect(s.dossier.rows[0].flag).toBe(true);
  });
});

describe("B6: unavailable or incompatible denominators are labelled, not divided", () => {
  it.each([
    [10, 0, "zero_denominator"], [10, -5, "negative_denominator"], [10, null, "missing"], [Number.POSITIVE_INFINITY, 2, "non_finite"],
  ] as const)("%s / %s → %s", (n, d, reason) => {
    expect(safeRatio(n, d)).toEqual({ available: false, reason });
  });
  it("coverage counts only the ratios that can be computed; there is no blended score", () => {
    const r = qualityValueRatios({ pe: { num: 100, den: 5 }, pb: { num: 100, den: 0 }, ev_ebitda: { num: 50, den: null } });
    expect(r).toEqual({ available: { pe: 20 }, unavailable: [{ name: "ev_ebitda", reason: "missing" }, { name: "pb", reason: "zero_denominator" }],
      coverage: "1 of 3 ratios available" });
    expect(r).not.toHaveProperty("score");
  });
});

describe("B8: anonymous and revoked-link requests cannot expose private data", () => {
  const d = dossier([row(GC, true, "E1", { values: { position_value: 125000 } })]);
  const now = new Date("2026-11-10T00:00:00Z");
  it("an active link returns only allowlisted fields", () => {
    const v = publicDossierView(d, { id: "l1", ticker: "AAPL", revoked: false, expires_at: null }, now);
    expect(v).toEqual({ ticker: "AAPL", as_of: "2026-11-08", findings: [{ scan_id: GC, flag: true, evidence_level: "E1" }], missing_count: 0 });
    expect(JSON.stringify(v)).not.toMatch(/position_value|125000|provenance/);
  });
  it.each([
    [undefined], [{ id: "l1", ticker: "AAPL", revoked: true, expires_at: null }],
    [{ id: "l1", ticker: "AAPL", revoked: false, expires_at: "2026-11-09T00:00:00Z" }],
    [{ id: "l1", ticker: "MSFT", revoked: false, expires_at: null }],
  ])("unknown, revoked, expired or mismatched links return nothing: %#", (link) => {
    expect(publicDossierView(d, link, now)).toBeNull();
  });
});
