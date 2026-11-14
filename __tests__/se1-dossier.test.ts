import { describe, expect, it } from "vitest";
import { SEED_CARDS, type EvidenceLevel } from "@/lib/shared/se1-catalog";
import { ALL_FEATURES, LOGIC_FEATURES } from "@/lib/shared/ai-features";
import {
  buildScanGraph, checkFaithfulness, coverageReport, decideAlert, detectContradictions, diffDossiers,
  dossierToMarkdown, holdFoldConfidence, missingEvidenceSection, nearDuplicates, type Dossier, type ScanRow,
} from "@/lib/shared/se1-dossier";

const prov = { source: "se1 test", feed: "alpaca_bars", as_of: "2026-11-08", scan_version: "1.0.0" };
const row = (scan_id: string, flag: boolean, evidence_level: EvidenceLevel = "E1", provenance: ScanRow["provenance"] = prov): ScanRow =>
  ({ scan_id, ticker: "AAPL", flag, evidence_level, provenance });
const dossier = (rows: ScanRow[], missing: Dossier["missing"] = []): Dossier => ({ ticker: "AAPL", as_of: "2026-11-08", rows, missing });
const GC = "se1.trend.golden_cross_recency";
const EX = "se1.trend.exit_close_under_200";

describe("dossier logic", () => {
  it("B7 diffs added, removed and flipped rows", () => {
    const d = diffDossiers(dossier([row(GC, false), row(EX, true), row("se1.vol.breakout_volume_confirm", true)]),
      dossier([row(GC, true), row(EX, true), row("se1.trend.ma_distance_atr", true)]));
    expect(d).toEqual({ ok: true, added: ["se1.trend.ma_distance_atr"], removed: ["se1.vol.breakout_volume_confirm"],
      flipped: [GC], unchanged: 1, versionChanged: [], evidenceChanged: [], newlyMissing: [], resolvedMissing: [] });
  });

  it("C4 lists missing scans, or says none are missing", () => {
    expect(missingEvidenceSection(dossier([]))).toEqual(["No scans were run for this dossier. There is no evidence to show."]);
    expect(missingEvidenceSection(dossier([row(GC, true)]))).toEqual(["No scans are missing from this dossier."]);
    expect(missingEvidenceSection(dossier([], [{ scan_id: "se1.news.x", reason: "feed not built" }]))).toEqual(["Missing se1.news.x: feed not built"]);
  });

  it("B9 export marks rows without provenance as unsourced", () => {
    const r = dossierToMarkdown(dossier([row(GC, true), row(EX, false, "E0", { source: "x" })]));
    expect(r.ok).toBe(true);
    const md = r.ok ? r.markdown : "";
    expect(md).toContain(`- ${GC}: flagged [E1] (Source se1 test`);
    expect(md).toContain(`- ${EX}: not flagged [E0] (unsourced: missing provenance)`);
    expect(md).toContain("## Missing evidence");
  });

  it("D6 needs both scans flagged at E3+ and a declared contradiction", () => {
    const strong = dossier([row(GC, true, "E3"), row(EX, true, "E4")]);
    expect(detectContradictions(strong, SEED_CARDS, 7).pairs).toEqual([{ a: EX, b: GC }]);
    expect(detectContradictions(dossier([row(GC, true, "E3"), row(EX, true, "E2")]), SEED_CARDS, 7).pairs).toEqual([]);
    expect(detectContradictions(dossier([row(GC, true, "E3"), row(EX, false, "E4")]), SEED_CARDS, 7).pairs).toEqual([]);
  });

  it("D9 respects quiet hours (including wrap past midnight) and the per-ticker cap", () => {
    const cfg = { quietStartHour: 22, quietEndHour: 7, maxPerTickerPerDay: 2 };
    expect(decideAlert(23, 0, cfg)).toEqual({ send: false, reason: "quiet_hours" });
    expect(decideAlert(6, 0, cfg)).toEqual({ send: false, reason: "quiet_hours" });
    expect(decideAlert(7, 0, cfg)).toEqual({ send: true });
    expect(decideAlert(12, 2, cfg)).toEqual({ send: false, reason: "ticker_budget" });
    expect(decideAlert(3, 0, { ...cfg, quietStartHour: 5, quietEndHour: 5 })).toEqual({ send: true });
    expect(decideAlert(22, 0, cfg)).toEqual({ send: false, reason: "quiet_hours" });
    expect(decideAlert(21, 0, cfg)).toEqual({ send: true });
    const day = { quietStartHour: 9, quietEndHour: 17, maxPerTickerPerDay: 5 };
    expect(decideAlert(9, 0, day)).toEqual({ send: false, reason: "quiet_hours" });
    expect(decideAlert(17, 0, day)).toEqual({ send: true });
  });

  it("F2 uses the strongest flagged evidence level, E0 when nothing backs the call", () => {
    expect(holdFoldConfidence([]).level).toBe("E0");
    expect(holdFoldConfidence([{ flag: false, evidence_level: "E4" }]).level).toBe("E0");
    expect(holdFoldConfidence([{ flag: true, evidence_level: "E1" }, { flag: true, evidence_level: "E3" }]).level).toBe("E3");
  });

  it("G5 stores each link once and drops unknown targets", () => {
    const { nodes, edges } = buildScanGraph(SEED_CARDS);
    expect(nodes).toHaveLength(SEED_CARDS.length);
    expect(edges.filter((e) => e.kind === "contradicts")).toEqual([{ from: EX, to: GC, kind: "contradicts" }]);
    const composes = edges.filter((e) => e.kind === "composes");
    expect(composes).toHaveLength(new Set(composes.map((e) => [e.from, e.to].sort().join())).size);
    expect(buildScanGraph([{ ...SEED_CARDS[0], composes_with: ["se1.trend.ghost"], contradicts: [] }]).edges).toEqual([]);
  });

  it("J2 flags figures without citations and citations without rows", () => {
    const r = checkFaithfulness(`The cross was ${GC} 4 days ago. Price rose 12%. See se1.vol.breakout_volume_confirm for volume. It looks fine.`, [{ scan_id: GC, flag: true }]);
    expect(r.grounded).toEqual(["It looks fine."]);
    expect(r.ungrounded.map((u) => u.why)).toEqual(["figure not in cited row", "cites a scan with no row"]);
    expect(r.unverifiable).toEqual(["Price rose 12%."]);
  });

  it("J5 finds highly correlated series and skips flat or short ones", () => {
    const up = [1, 2, 3, 4, 5, 6];
    const found = nearDuplicates({ a: up, b: up.map((x) => x * 2 + 1), c: [6, 1, 5, 2, 4, 3], flat: [1, 1, 1, 1, 1, 1], short: [1, 2] });
    expect(found).toEqual([{ a: "a", b: "b", r: 1 }]);
  });

  it("J9 coverage counts written cards and blocked families", () => {
    const c = coverageReport(SEED_CARDS);
    expect(c.written).toBe(SEED_CARDS.length);
    expect(c.planned).toBe(200);
    expect(c.blocked).toBeGreaterThan(0);
    expect(c.families.find((f) => f.family === "trend")).toMatchObject({ written: 3, blocked: false });
  });

  it("registry: logic features are unique, C0, and listed in ALL_FEATURES", () => {
    expect(LOGIC_FEATURES).toHaveLength(12);
    expect(new Set(ALL_FEATURES.map((f) => f.id)).size).toBe(23);
    expect(LOGIC_FEATURES.every((f) => f.cost === "C0")).toBe(true);
  });
});
