import { describe, expect, it } from "vitest";
import { SEED_CARDS, type EvidenceLevel } from "@/lib/shared/se1-catalog";
import {
  checkFaithfulness, decideAlert, detectContradictions, diffDossiers, dossierToMarkdown, localHourFor,
  splitSentences, extractFigures, type Dossier, type ScanRow,
} from "@/lib/shared/se1-dossier";

const prov = { source: "se1 test", feed: "alpaca_bars", as_of: "2026-11-08", scan_version: "1.0.0" };
const row = (scan_id: string, flag: boolean, evidence_level: EvidenceLevel = "E1",
  provenance: ScanRow["provenance"] = prov, values?: ScanRow["values"], ticker = "AAPL"): ScanRow =>
  ({ scan_id, ticker, flag, evidence_level, provenance, values });
const dossier = (rows: ScanRow[], missing: Dossier["missing"] = [], ticker = "AAPL"): Dossier =>
  ({ ticker, as_of: "2026-11-08", rows, missing });
const GC = "se1.trend.golden_cross_recency";
const EX = "se1.trend.exit_close_under_200";

describe("R1: J2 narration check rejects fabricated figures", () => {
  it("a figure not present on the cited row is ungrounded", () => {
    const r = checkFaithfulness(`${GC} shows RSI at 97.3 and price up 450%.`, [row(GC, true, "E1", prov, { rsi: 14.2, change_pct: 450 })]);
    expect(r.ungrounded).toEqual([{ sentence: `${GC} shows RSI at 97.3 and price up 450%.`, why: "figure not in cited row" }]);
    expect(r.grounded).toEqual([]);
  });
  it("figures that match the cited row's values pass, with percent normalized", () => {
    const r = checkFaithfulness(`${GC} shows RSI at 97.3 and price up 450%.`, [row(GC, true, "E1", prov, { rsi: 97.3, change_pct: 4.5 })]);
    expect(r.grounded).toEqual([`${GC} shows RSI at 97.3 and price up 450%.`]);
  });
  it("does not split on U.S. and still checks the figure", () => {
    const r = checkFaithfulness(`The U.S. market rose 3 pts per ${GC}.`, [row(GC, true, "E1", prov, { rsi: 97.3 })]);
    expect(splitSentences(`The U.S. market rose 3 pts per ${GC}.`)).toHaveLength(1);
    expect(r.ungrounded).toEqual([{ sentence: `The U.S. market rose 3 pts per ${GC}.`, why: "figure not in cited row" }]);
  });
  it("a negated cite of a non-flagged row is grounded; an unnegated one is not", () => {
    expect(checkFaithfulness(`${GC} did not flag, so the trend is strongly bullish.`, [row(GC, false)]).grounded)
      .toEqual([`${GC} did not flag, so the trend is strongly bullish.`]);
    const r = checkFaithfulness(`${GC} confirms the uptrend.`, [row(GC, false)]);
    expect(r.ungrounded).toEqual([{ sentence: `${GC} confirms the uptrend.`, why: "cites a non-flagged row without saying so" }]);
  });
  it("number words are figures: an uncited claim is unverifiable, not grounded", () => {
    const r = checkFaithfulness("Price doubled and gained ninety percent.", [row(GC, true)]);
    expect(r.unverifiable).toEqual(["Price doubled and gained ninety percent."]);
    expect(r.grounded).toEqual([]);
  });
  it("two figures in one sentence: one real, one fabricated is ungrounded", () => {
    const r = checkFaithfulness(`${GC} shows RSI at 97.3 with volume up 40%.`, [row(GC, true, "E1", prov, { rsi: 97.3 })]);
    expect(r.ungrounded).toEqual([{ sentence: `${GC} shows RSI at 97.3 with volume up 40%.`, why: "figure not in cited row" }]);
  });
  it("a correct figure in the wrong unit does not match; the right unit does", () => {
    expect(checkFaithfulness(`${GC} hit rate was 61.`, [row(GC, true, "E1", prov, { hit_rate: 0.61 })]).ungrounded)
      .toEqual([{ sentence: `${GC} hit rate was 61.`, why: "figure not in cited row" }]);
    expect(checkFaithfulness(`${GC} hit rate was 61%.`, [row(GC, true, "E1", prov, { hit_rate: 0.61 })]).grounded)
      .toEqual([`${GC} hit rate was 61%.`]);
  });
});

describe("R2: B7 diff refuses mixed tickers and keeps version/evidence changes", () => {
  it("rejects a cross-ticker diff and duplicate scan IDs", () => {
    expect(diffDossiers(dossier([row(GC, true)]), dossier([row(GC, true)], [], "MSFT")))
      .toMatchObject({ ok: false, error: expect.stringContaining("ticker mismatch") });
    expect(diffDossiers(dossier([row(GC, true), row(GC, false)]), dossier([row(GC, true)])))
      .toMatchObject({ ok: false, error: expect.stringContaining("duplicate scan_id") });
  });
  it("a version change is not a flip; evidence and missing changes are reported", () => {
    const prev = dossier([row(GC, false, "E1"), row(EX, true, "E1")], [{ scan_id: "se1.vol.breakout_volume_confirm", reason: "feed" }]);
    const currRows = [
      row(GC, true, "E3", { ...prov, scan_version: "2.0.0" }),
      row(EX, true, "E2"),
    ];
    const d = diffDossiers(prev, dossier(currRows, [{ scan_id: "se1.news.sentiment", reason: "feed" }]));
    expect(d).toMatchObject({ ok: true, flipped: [], versionChanged: [GC], evidenceChanged: [EX, GC],
      newlyMissing: ["se1.news.sentiment"], resolvedMissing: ["se1.vol.breakout_volume_confirm"] });
  });
});

describe("R3: B9 markdown export cannot be forged", () => {
  it("rejects invalid ticker, scan ID and date instead of rendering them", () => {
    expect(dossierToMarkdown(dossier([row(GC, true)])).ok).toBe(true);
    expect(dossierToMarkdown({ ...dossier([row(GC, true)]), ticker: "X\n# Injected <script>" })).toMatchObject({ ok: false, error: "invalid ticker" });
    expect(dossierToMarkdown(dossier([row("se1.trend.x\n- fake: flagged [E4]", true)]))).toMatchObject({ ok: false });
    expect(dossierToMarkdown({ ...dossier([row(GC, true)]), as_of: "not-a-date" })).toMatchObject({ ok: false, error: "invalid as_of" });
  });
  it("escapes free text so a missing-reason cannot inject a Findings section", () => {
    const r = dossierToMarkdown(dossier([row(GC, true)], [{ scan_id: "se1.news.sentiment", reason: "feed down\n## Findings\n- fake: flagged [E4]" }]));
    expect(r.ok).toBe(true);
    const md = r.ok ? r.markdown : "";
    expect(md).not.toContain("\n## Findings\n- fake");
    expect(md).not.toContain("\n- fake: flagged");
  });
});

describe("R5: D6 contradiction alert ignores stale, unsourced, foreign-ticker and retired rows", () => {
  const strong = () => dossier([row(GC, true, "E3"), row(EX, true, "E4")]);
  it("qualified rows still pair; disqualified rows are reported with reasons", () => {
    expect(detectContradictions(strong(), SEED_CARDS, 7).pairs).toEqual([{ a: EX, b: GC }]);
    const stale = dossier([row(GC, true, "E3", { ...prov, as_of: "2019-01-01" }), row(EX, true, "E4")]);
    const r1 = detectContradictions(stale, SEED_CARDS, 7);
    expect(r1.pairs).toEqual([]);
    expect(r1.disqualified).toEqual([{ scan_id: GC, reason: "stale" }]);
    const unsourced = dossier([row(GC, true, "E3", { source: "x" }), row(EX, true, "E4")]);
    expect(detectContradictions(unsourced, SEED_CARDS, 7).disqualified).toEqual([{ scan_id: GC, reason: "no_provenance" }]);
    const foreign = dossier([{ ...row(GC, true, "E3"), ticker: "MSFT" }, row(EX, true, "E4")]);
    expect(detectContradictions(foreign, SEED_CARDS, 7).disqualified).toEqual([{ scan_id: GC, reason: "wrong_ticker" }]);
    const retired = SEED_CARDS.map((c) => (c.id === GC ? { ...c, status: "retired" as const } : c));
    expect(detectContradictions(strong(), retired, 7).disqualified).toEqual([{ scan_id: GC, reason: "retired_card" }]);
  });
});

describe("R6: D9 alert budget fails closed on bad input", () => {
  const cfg = { quietStartHour: 22, quietEndHour: 7, maxPerTickerPerDay: 2 };
  it("NaN, out-of-range, fractional or negative inputs never send", () => {
    for (const bad of [NaN, -1, 24, 25, 6.99, Infinity]) {
      expect(decideAlert(bad, 0, cfg)).toEqual({ send: false, reason: "invalid_input" });
    }
    expect(decideAlert(12, -5, cfg)).toEqual({ send: false, reason: "invalid_input" });
    expect(decideAlert(12, 0, { ...cfg, quietStartHour: NaN })).toEqual({ send: false, reason: "invalid_input" });
    expect(decideAlert(12, 0, { ...cfg, maxPerTickerPerDay: NaN })).toEqual({ send: false, reason: "invalid_input" });
    expect(decideAlert(12, 0, { ...cfg, maxPerTickerPerDay: 1.5 })).toEqual({ send: false, reason: "invalid_input" });
  });
  it("derives the local hour from a Date and IANA timezone, across both DST transitions", () => {
    expect(localHourFor(new Date("2026-03-08T06:30:00Z"), "America/New_York")).toBe(1); // 23-hour day, still EST
    expect(localHourFor(new Date("2026-03-08T08:30:00Z"), "America/New_York")).toBe(4); // EDT, 02:00-03:00 never existed
    expect(localHourFor(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe(1); // first 1:30 (EDT)
    expect(localHourFor(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe(1); // second 1:30 (EST)
    expect(localHourFor(new Date("2026-11-14T03:00:00Z"), "America/New_York")).toBe(22); // wrap-midnight window start
    expect(decideAlert(localHourFor(new Date("2026-11-14T03:00:00Z"), "America/New_York")!, 0, cfg))
      .toEqual({ send: false, reason: "quiet_hours" });
    expect(localHourFor(new Date(), "Not/AZone")).toBeNull();
  });
});

describe("CodeRabbit follow-ups on PR #374 (fail-closed)", () => {
  it("rejects an as_of that carries markup through fallback Date.parse", () => {
    expect(dossierToMarkdown({ ticker: "AAPL", as_of: "2026-11-08\n## Findings\n- fake: flagged [E4]", rows: [], missing: [] }))
      .toEqual({ ok: false, error: "invalid as_of" });
  });
  it("detectContradictions rejects NaN/Infinity/negative maxAgeDays before qualifying rows", () => {
    const rows = [row(GC, true, "E1", { ...prov, as_of: "2019-01-01" }), row(EX, true, "E1")];
    const d = dossier(rows);
    const cards = SEED_CARDS.map((c) => c.id === GC ? { ...c, contradicts: [EX] } : c);
    for (const bad of [NaN, Infinity, -1]) {
      expect(detectContradictions(d, cards, bad)).toEqual({ pairs: [], disqualified: [] });
    }
  });
  it("extractFigures reads fractions without a leading zero", () => {
    expect(extractFigures("Price rose .5%.")).toEqual([{ value: 0.5, isPercent: true }]);
    expect(checkFaithfulness("Price rose .5%.", [row(GC, true)]).unverifiable).toEqual(["Price rose .5%."]);
  });
  it("parses compound number words as one figure, so 90 does not ground a 99% claim", () => {
    expect(extractFigures(`${GC} reports ninety-nine percent.`)).toEqual([{ value: 99, isPercent: true }]);
    const r = checkFaithfulness(`${GC} reports ninety-nine percent.`, [row(GC, true, "E1", prov, { hit_rate: 0.9 })]);
    expect(r.ungrounded).toEqual([{ sentence: `${GC} reports ninety-nine percent.`, why: "figure not in cited row" }]);
  });
  it("polarity is per claim: negation must describe the flag; ambiguous negation is unverifiable", () => {
    expect(checkFaithfulness(`${GC} did not flag.`, [row(GC, true)]).ungrounded)
      .toEqual([{ sentence: `${GC} did not flag.`, why: "negated flag claim contradicts a flagged row" }]);
    expect(checkFaithfulness(`${GC} confirms the uptrend with no caveats.`, [row(GC, false)]).unverifiable)
      .toEqual([`${GC} confirms the uptrend with no caveats.`]);
    expect(checkFaithfulness(`${GC} did not flag.`, [row(GC, false)]).grounded).toEqual([`${GC} did not flag.`]);
  });
});
