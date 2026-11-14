import { describe, expect, it } from "vitest";
import {
  clearUserContext, compareOnRecipe, compileScreen, contextCacheKey, counterEvidence, matchScanQuestion,
  newsBeforeCutoff, resolveCitations, validateScanParams,
} from "@/lib/shared/se1/ask";
import { card, dossier, EX, GC, row } from "./fixtures";

describe("A1: news after the cutoff is excluded and never presented as the cause", () => {
  it("keeps items at or before the cutoff and explains each exclusion", () => {
    const r = newsBeforeCutoff([
      { id: "a", published_at: "2026-11-08T13:00:00Z", headline: "before" },
      { id: "b", published_at: "2026-11-08T21:00:01Z", headline: "after" },
      { id: "c", published_at: "yesterday", headline: "undated" },
    ], "2026-11-08T21:00:00Z");
    if ("error" in r) throw new Error(r.error);
    expect(r.kept.map((i) => i.id)).toEqual(["a"]);
    expect(r.excluded).toEqual([{ id: "b", reason: "after_cutoff" }, { id: "c", reason: "no_timestamp" }]);
    expect(r.causation_note).toMatch(/not a proven cause/);
  });
  it("an invalid cutoff is an error, not 'everything'", () => {
    expect(newsBeforeCutoff([], "soon")).toEqual({ error: "invalid cutoff" });
  });
});

describe("A2: ambiguous matches ask for clarification; unsupported parameters never run", () => {
  const cards = [
    card("se1.trend.golden_cross_recency", { title: "Golden cross recency", question: "How recently did the 50 day cross above the 200 day?" }),
    card("se1.trend.death_cross_recency", { title: "Death cross recency", question: "How recently did the 50 day cross below the 200 day?" }),
    card("se1.mom.rsi_oversold", { title: "RSI oversold", question: "Is RSI below 30?", min_bars: 15 }),
  ];
  it("one clear leader matches", () => {
    expect(matchScanQuestion("is the rsi oversold", cards)).toMatchObject({ kind: "match", card: "se1.mom.rsi_oversold" });
  });
  it("a tie asks the user to choose", () => {
    const r = matchScanQuestion("how recently did the 50 day cross the 200 day", cards);
    expect(r.kind).toBe("clarify");
    if (r.kind === "clarify") expect(r.candidates).toEqual(["se1.trend.death_cross_recency", "se1.trend.golden_cross_recency"]);
  });
  it("no match says so", () => {
    expect(matchScanQuestion("weather tomorrow", cards).kind).toBe("none");
  });
  it("unknown or malformed parameters are rejected", () => {
    expect(validateScanParams(cards[2], { ticker: "AAPL", lookback_bars: 30 })).toEqual({ ok: true });
    const r = validateScanParams(cards[2], { ticker: "aapl; drop", window: 9, lookback_bars: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("|")).toMatch(/unsupported parameter: window.*ticker.*lookback_bars/);
  });
});

describe("A3: citations open the versioned card; unknown citations fail visibly (audit R10)", () => {
  it("a known ID carries its version; an unknown well-formed ID is unknown_scan, not a link", () => {
    const parts = resolveCitations(`See ${GC} and se1.trend.not_a_real_card.`, [{ id: GC, version: "2.1.0" }]);
    expect(parts).toEqual([
      { type: "text", text: "See " },
      { type: "scan", id: GC, version: "2.1.0" },
      { type: "text", text: " and " },
      { type: "unknown_scan", id: "se1.trend.not_a_real_card" },
      { type: "text", text: "." },
    ]);
  });
});

describe("A4: no contradicting evidence yields an explicit gap", () => {
  const cards = [card(GC, { contradicts: [EX] }), card(EX, { contradicts: [GC] })];
  it("a flagged contrary row is returned as a pair", () => {
    expect(counterEvidence(dossier([row(GC, true), row(EX, true)]), cards).pairs).toContainEqual({ supports: GC, against: EX });
  });
  it.each([
    [[row(GC, false)], "no_flagged_rows"],
    [[row(GC, true)], "contrary_scans_not_run"],
    [[row(GC, true), row(EX, false)], "contrary_scans_did_not_flag"],
  ] as const)("gap is named: %#", (rows, gap) => {
    expect(counterEvidence(dossier([...rows]), cards)).toEqual({ pairs: [], gap });
  });
  it("no relation at all is its own gap", () => {
    expect(counterEvidence(dossier([row(GC, true)]), [card(GC)]).gap).toBe("no_contradicts_relation");
  });
});

describe("A5: different dates or missing inputs prevent a like-for-like comparison", () => {
  it("refuses different dates", () => {
    expect(compareOnRecipe(dossier([row(GC, true)]), dossier([row(GC, true, "E1", { ticker: "MSFT" })], [], "MSFT", "2026-11-07"), [GC]))
      .toMatchObject({ ok: false, error: expect.stringContaining("dates differ") });
  });
  it("names every scan that is not comparable", () => {
    const a = dossier([row(GC, true), row(EX, false)]);
    const b = dossier([row(GC, false, "E1", { ticker: "MSFT", provenance: { ...row(GC, true).provenance, scan_version: "2.0.0" } })], [], "MSFT");
    const r = compareOnRecipe(a, b, [GC, EX]);
    expect(r).toMatchObject({ ok: true, likeForLike: false, comparable: [],
      notComparable: [{ scan_id: GC, reason: "version_differs" }, { scan_id: EX, reason: "missing_in_b" }] });
  });
});

describe("A6: unsupported filters are rejected before running", () => {
  it("valid filters compile", () => {
    expect(compileScreen([{ field: "rsi_14", op: "lt", value: 30 }, { field: "sma200_slope_pct", op: "gt", value: 0 }]))
      .toEqual({ ok: true, query: [{ field: "rsi_14", op: "lt", value: 30 }, { field: "sma200_slope_pct", op: "gt", value: 0 }] });
  });
  it("one bad filter rejects the whole screen", () => {
    const r = compileScreen([{ field: "rsi_14", op: "lt", value: 30 }, { field: "insider_mood", op: "gt", value: 1 },
      { field: "rsi_14", op: "between", value: 1 }, { field: "rsi_14", op: "lt", value: 400 }, { field: "rsi_14", op: "lt", value: Number.NaN }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(4);
  });
});

describe("A8: switching users or logging out clears private context", () => {
  it("keys always carry the user and cannot collide across users", () => {
    expect(contextCacheKey("u1", "holdings")).toBe("ctx:u1:holdings");
    expect(contextCacheKey("u1:holdings", "followed")).not.toMatch(/^ctx:u1:/);
    expect(() => contextCacheKey("", "holdings")).toThrow(/user id/);
    expect(() => contextCacheKey("u1", "secrets" as never)).toThrow(/scope/);
  });
  it("logout removes only that user's keys", () => {
    const store = new Map([[contextCacheKey("u1", "holdings"), 1], [contextCacheKey("u1", "conversation"), 2], [contextCacheKey("u2", "holdings"), 3]]);
    expect([...clearUserContext(store, "u1").keys()]).toEqual(["ctx:u2:holdings"]);
  });
});
