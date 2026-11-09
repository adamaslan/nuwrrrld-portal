import { describe, expect, it } from "vitest";
import {
  holdFoldReasons, topScansBehindAnswer, weakestLinks, portfolioRisk, regimeBanner,
} from "@/lib/shared/se1-roadmap2";
import { ALL_FEATURES } from "@/lib/shared/ai-features";
import type { ScanRow } from "@/lib/shared/se1-dossier";

const prov = { source: "alpaca", feed: "sip", as_of: "2026-11-06", scan_version: "1" };
const row = (id: string, o: Partial<ScanRow> = {}): ScanRow =>
  ({ scan_id: id, ticker: "AAA", flag: true, evidence_level: "E1", provenance: prov, ...o });

describe("F1 holdFoldReasons", () => {
  it("returns at most 5, strongest first, ties by id", () => {
    const rows = ["g", "f", "e", "d", "c", "b", "a"].map((id) => row(id));
    rows.push(row("z", { evidence_level: "E3" }));
    const out = holdFoldReasons(rows).rows.map((r) => r.scan_id);
    expect(out).toEqual(["z", "a", "b", "c", "d"]);
  });
  it("allows fewer than five and invents none", () => {
    expect(holdFoldReasons([row("a")]).rows).toHaveLength(1);
    expect(holdFoldReasons([]).rows).toEqual([]);
  });
  it("skips unflagged rows silently and unsourced/duplicate rows with a reason", () => {
    const out = holdFoldReasons([row("a", { flag: false }), row("b", { provenance: { source: "x" } }), row("c"), row("c")]);
    expect(out.rows.map((r) => r.scan_id)).toEqual(["c"]);
    expect(out.skipped).toEqual([
      { scan_id: "b", why: "missing provenance" }, { scan_id: "c", why: "duplicate row" }]);
  });
});

describe("C9 topScansBehindAnswer", () => {
  it("returns only cited scans, max 3, no filler", () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) => row(id));
    expect(topScansBehindAnswer(["a", "b", "c", "d"], rows).rows).toHaveLength(3);
    expect(topScansBehindAnswer(["a"], rows).rows.map((r) => r.scan_id)).toEqual(["a"]);
  });
  it("reports cited ids with no sourced row as unresolved", () => {
    const out = topScansBehindAnswer(["a", "ghost", "b"], [row("a"), row("b", { provenance: {} })]);
    expect(out.rows.map((r) => r.scan_id)).toEqual(["a"]);
    expect(out.unresolved).toEqual(["b", "ghost"]);
  });
});

describe("E3 weakestLinks", () => {
  it("ranks by weakness and excludes holdings with missing inputs", () => {
    const out = weakestLinks([
      { ticker: "OK", weight: 1, trend: 80, risk: 20 },
      { ticker: "BAD", weight: 1, trend: 10, risk: 90 },
      { ticker: "NOTREND", weight: 1, risk: 99 },
      { ticker: "NAN", weight: 1, trend: Number.NaN, risk: null },
      { ticker: "RANGE", weight: 1, trend: 120, risk: 5 },
    ]);
    expect(out.ranked).toEqual([{ ticker: "BAD", weakness: 90 }, { ticker: "OK", weakness: 20 }]);
    expect(out.excluded.map((e) => e.ticker)).toEqual(["NOTREND", "NAN", "RANGE"]);
    expect(out.excluded[1].why).toBe("missing or invalid trend and risk");
  });
});

describe("E1 portfolioRisk", () => {
  it("weights risk over covered holdings and reports coverage", () => {
    const r = portfolioRisk([
      { ticker: "A", weight: 3, risk: 40 }, { ticker: "B", weight: 1, risk: 80 }, { ticker: "C", weight: 4 }]);
    expect(r.risk).toBe(50);
    expect(r.coverage).toBe(0.5);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual(["C"]);
  });
  it("never treats missing risk as zero; null when nothing is covered", () => {
    const r = portfolioRisk([{ ticker: "A", weight: 1 }]);
    expect(r.risk).toBeNull();
    expect(r.coverage).toBe(0);
  });
  it("is complete only with full coverage; empty or bad weights are not complete", () => {
    expect(portfolioRisk([{ ticker: "A", weight: 1, risk: 10 }]).complete).toBe(true);
    expect(portfolioRisk([]).complete).toBe(false);
    expect(portfolioRisk([{ ticker: "A", weight: -1, risk: 10 }]).risk).toBeNull();
  });
});

describe("D4 regimeBanner", () => {
  const h = (...r: (string | null)[]) => r.map((regime, i) => ({ as_of: `2026-11-0${i + 1}`, regime }));
  it("does not flip on a single noisy observation", () => {
    expect(regimeBanner(h("calm", "calm", "calm", "storm", "calm", "calm"))).toEqual({ state: "stable", current: "calm" });
  });
  it("reports a change once the new regime is confirmed", () => {
    expect(regimeBanner(h("calm", "calm", "storm", "storm"))).toEqual({ state: "changed", current: "storm", previous: "calm" });
  });
  it("is unavailable when the latest is missing, unconfirmed, empty, or minRun invalid", () => {
    expect(regimeBanner(h("calm", "calm", null)).state).toBe("unavailable");
    expect(regimeBanner(h("calm", "calm", "storm")).state).toBe("unavailable");
    expect(regimeBanner([]).state).toBe("unavailable");
    expect(regimeBanner(h("a", "a"), 0).state).toBe("unavailable");
  });
  it("a null breaks a run", () => {
    expect(regimeBanner(h("calm", null, "calm")).state).toBe("unavailable");
  });
});

describe("registry", () => {
  it("lists the five roadmap-2 features as logic_only C0", () => {
    for (const id of ["F1", "C9", "E3", "E1", "D4"]) {
      const f = ALL_FEATURES.find((x) => x.id === id);
      expect(f, id).toBeDefined();
      expect(f?.status).toBe("logic_only");
      expect(f?.cost).toBe("C0");
    }
  });
});
